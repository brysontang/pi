#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <dlfcn.h>
#include <poll.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#define NAPI_AUTO_LENGTH ((size_t)-1)
#define MAX_CLIPBOARD_BYTES (50u * 1024u * 1024u)
#define EVENT_TIMEOUT_MS 2000

typedef void* napi_env;
typedef void* napi_value;
typedef void* napi_callback_info;
typedef napi_value (*napi_callback)(napi_env, napi_callback_info);
typedef int (*napi_create_buffer_copy_fn)(napi_env, size_t, const void*, void**, napi_value*);
typedef int (*napi_create_function_fn)(napi_env, const char*, size_t, napi_callback, void*, napi_value*);
typedef int (*napi_create_string_utf8_fn)(napi_env, const char*, size_t, napi_value*);
typedef int (*napi_get_boolean_fn)(napi_env, bool, napi_value*);
typedef int (*napi_get_undefined_fn)(napi_env, napi_value*);
typedef int (*napi_set_named_property_fn)(napi_env, napi_value, const char*, napi_value);
typedef int (*napi_throw_error_fn)(napi_env, const char*, const char*);

typedef struct {
    unsigned char* data;
    size_t length;
    unsigned long items;
    int format;
    Atom type;
} property_data;

typedef struct {
    Display* display;
    Window window;
    Atom clipboard;
    Atom property;
    Atom targets;
    Atom incr;
} x11_clipboard;

static void* node_symbol(const char* name) {
    return dlsym(RTLD_DEFAULT, name);
}

static napi_value undefined_value(napi_env env) {
    napi_get_undefined_fn napi_get_undefined = (napi_get_undefined_fn)node_symbol("napi_get_undefined");
    napi_value result = 0;
    if (napi_get_undefined) napi_get_undefined(env, &result);
    return result;
}

static napi_value fail(napi_env env, const char* message) {
    napi_throw_error_fn napi_throw_error = (napi_throw_error_fn)node_symbol("napi_throw_error");
    if (napi_throw_error) napi_throw_error(env, 0, message);
    return undefined_value(env);
}

static bool append_bytes(property_data* result, const unsigned char* bytes, size_t length) {
    if (length > MAX_CLIPBOARD_BYTES - result->length) return false;
    unsigned char* data = realloc(result->data, result->length + length + 1);
    if (!data) return false;
    memcpy(data + result->length, bytes, length);
    result->length += length;
    data[result->length] = 0;
    result->data = data;
    return true;
}

static bool wait_for_event(x11_clipboard* clipboard, int type, XEvent* event) {
    while (true) {
        while (XPending(clipboard->display)) {
            XNextEvent(clipboard->display, event);
            if (event->type == type) return true;
        }
        struct pollfd descriptor = {ConnectionNumber(clipboard->display), POLLIN, 0};
        if (poll(&descriptor, 1, EVENT_TIMEOUT_MS) <= 0) return false;
    }
}

static bool read_property(x11_clipboard* clipboard, bool remove, property_data* result) {
    Atom actual_type = None;
    int actual_format = 0;
    unsigned long items = 0;
    unsigned long remaining = 0;
    unsigned char* value = 0;
    int status = XGetWindowProperty(
        clipboard->display,
        clipboard->window,
        clipboard->property,
        0,
        MAX_CLIPBOARD_BYTES / 4,
        remove,
        AnyPropertyType,
        &actual_type,
        &actual_format,
        &items,
        &remaining,
        &value
    );
    if (status != Success || remaining != 0 || actual_type == None) {
        if (value) XFree(value);
        return false;
    }

    size_t item_size = actual_format == 32 ? sizeof(unsigned long) : (size_t)actual_format / 8;
    size_t length = items * item_size;
    result->type = actual_type;
    result->format = actual_format;
    result->items = items;
    bool copied = append_bytes(result, value, length);
    if (value) XFree(value);
    return copied;
}

static bool request_selection(x11_clipboard* clipboard, Atom target, property_data* result) {
    memset(result, 0, sizeof(*result));
    XDeleteProperty(clipboard->display, clipboard->window, clipboard->property);
    XConvertSelection(
        clipboard->display,
        clipboard->clipboard,
        target,
        clipboard->property,
        clipboard->window,
        CurrentTime
    );
    XFlush(clipboard->display);

    XEvent event;
    do {
        if (!wait_for_event(clipboard, SelectionNotify, &event)) return false;
    } while (event.xselection.selection != clipboard->clipboard || event.xselection.target != target);
    if (event.xselection.property == None || !read_property(clipboard, false, result)) return false;
    if (result->type != clipboard->incr) return true;

    free(result->data);
    memset(result, 0, sizeof(*result));
    XDeleteProperty(clipboard->display, clipboard->window, clipboard->property);
    XFlush(clipboard->display);

    while (true) {
        do {
            if (!wait_for_event(clipboard, PropertyNotify, &event)) return false;
        } while (event.xproperty.atom != clipboard->property || event.xproperty.state != PropertyNewValue);

        property_data chunk = {0};
        if (!read_property(clipboard, true, &chunk)) return false;
        if (chunk.items == 0) {
            free(chunk.data);
            return true;
        }
        bool appended = append_bytes(result, chunk.data, chunk.length);
        if (result->type == None) {
            result->type = chunk.type;
            result->format = chunk.format;
        }
        result->items += chunk.items;
        free(chunk.data);
        if (!appended) return false;
    }
}

static bool open_clipboard(x11_clipboard* clipboard) {
    memset(clipboard, 0, sizeof(*clipboard));
    clipboard->display = XOpenDisplay(0);
    if (!clipboard->display) return false;
    clipboard->window = XCreateSimpleWindow(
        clipboard->display,
        DefaultRootWindow(clipboard->display),
        0,
        0,
        1,
        1,
        0,
        0,
        0
    );
    XSelectInput(clipboard->display, clipboard->window, PropertyChangeMask);
    clipboard->clipboard = XInternAtom(clipboard->display, "CLIPBOARD", False);
    clipboard->property = XInternAtom(clipboard->display, "PI_CLIPBOARD", False);
    clipboard->targets = XInternAtom(clipboard->display, "TARGETS", False);
    clipboard->incr = XInternAtom(clipboard->display, "INCR", False);
    return clipboard->window && clipboard->clipboard && clipboard->property;
}

static void close_clipboard(x11_clipboard* clipboard) {
    if (!clipboard->display) return;
    if (clipboard->window) XDestroyWindow(clipboard->display, clipboard->window);
    XCloseDisplay(clipboard->display);
}

static Atom preferred_target(x11_clipboard* clipboard, bool image) {
    static const char* text_types[] = {
        "text/plain;charset=utf-8",
        "text/plain;charset=UTF-8",
        "UTF8_STRING",
        "text/plain",
        "STRING",
    };
    static const char* image_types[] = {
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
        "image/bmp",
        "image/tiff",
    };
    const char** types = image ? image_types : text_types;
    size_t type_count = image ? 6 : 5;
    Atom wanted[6];
    for (size_t index = 0; index < type_count; index++) {
        wanted[index] = XInternAtom(clipboard->display, types[index], False);
    }

    property_data targets = {0};
    if (request_selection(clipboard, clipboard->targets, &targets) && targets.format == 32) {
        unsigned long* offered = (unsigned long*)targets.data;
        for (size_t wanted_index = 0; wanted_index < type_count; wanted_index++) {
            for (unsigned long offered_index = 0; offered_index < targets.items; offered_index++) {
                if ((Atom)offered[offered_index] == wanted[wanted_index]) {
                    free(targets.data);
                    return wanted[wanted_index];
                }
            }
        }
    }
    free(targets.data);
    return None;
}

static bool read_clipboard(bool image, property_data* result) {
    x11_clipboard clipboard;
    if (!open_clipboard(&clipboard)) return false;
    Atom target = preferred_target(&clipboard, image);
    bool received = target != None && request_selection(&clipboard, target, result);
    close_clipboard(&clipboard);
    return received;
}

static napi_value is_clipboard_available(napi_env env, napi_callback_info info) {
    (void)info;
    x11_clipboard clipboard;
    bool available = open_clipboard(&clipboard);
    close_clipboard(&clipboard);

    napi_get_boolean_fn napi_get_boolean = (napi_get_boolean_fn)node_symbol("napi_get_boolean");
    napi_value result = 0;
    if (!napi_get_boolean || napi_get_boolean(env, available, &result) != 0) {
        return fail(env, "Could not inspect X11 clipboard availability");
    }
    return result;
}

static napi_value get_clipboard_text(napi_env env, napi_callback_info info) {
    (void)info;
    property_data contents = {0};
    if (!read_clipboard(false, &contents)) return fail(env, "X11 clipboard does not contain text");

    napi_create_string_utf8_fn napi_create_string_utf8 =
        (napi_create_string_utf8_fn)node_symbol("napi_create_string_utf8");
    napi_value result = 0;
    int status = napi_create_string_utf8
        ? napi_create_string_utf8(env, (const char*)contents.data, contents.length, &result)
        : 1;
    free(contents.data);
    return status == 0 ? result : fail(env, "Could not create clipboard text");
}

static napi_value has_clipboard_image(napi_env env, napi_callback_info info) {
    (void)info;
    x11_clipboard clipboard;
    bool opened = open_clipboard(&clipboard);
    bool available = opened && preferred_target(&clipboard, true) != None;
    close_clipboard(&clipboard);

    napi_get_boolean_fn napi_get_boolean = (napi_get_boolean_fn)node_symbol("napi_get_boolean");
    napi_value result = 0;
    if (!napi_get_boolean || napi_get_boolean(env, available, &result) != 0) {
        return fail(env, "Could not inspect X11 clipboard");
    }
    return result;
}

static napi_value get_clipboard_image(napi_env env, napi_callback_info info) {
    (void)info;
    property_data contents = {0};
    if (!read_clipboard(true, &contents)) return fail(env, "X11 clipboard does not contain an image");

    napi_create_buffer_copy_fn napi_create_buffer_copy =
        (napi_create_buffer_copy_fn)node_symbol("napi_create_buffer_copy");
    napi_value result = 0;
    int status = napi_create_buffer_copy
        ? napi_create_buffer_copy(env, contents.length, contents.data, 0, &result)
        : 1;
    free(contents.data);
    return status == 0 ? result : fail(env, "Could not create clipboard image buffer");
}

static void set_function_export(napi_env env, napi_value exports, const char* name, napi_callback callback) {
    napi_create_function_fn napi_create_function = (napi_create_function_fn)node_symbol("napi_create_function");
    napi_set_named_property_fn napi_set_named_property =
        (napi_set_named_property_fn)node_symbol("napi_set_named_property");
    napi_value fn = 0;
    if (napi_create_function && napi_set_named_property &&
        napi_create_function(env, name, NAPI_AUTO_LENGTH, callback, 0, &fn) == 0) {
        napi_set_named_property(env, exports, name, fn);
    }
}

__attribute__((visibility("default"))) napi_value napi_register_module_v1(napi_env env, napi_value exports) {
    set_function_export(env, exports, "isClipboardAvailable", is_clipboard_available);
    set_function_export(env, exports, "getClipboardText", get_clipboard_text);
    set_function_export(env, exports, "hasClipboardImage", has_clipboard_image);
    set_function_export(env, exports, "getClipboardImage", get_clipboard_image);
    return exports;
}
