#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#include <dlfcn.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>

#define NAPI_AUTO_LENGTH ((size_t)-1)

typedef void* napi_env;
typedef void* napi_value;
typedef void* napi_callback_info;
typedef napi_value (*napi_callback)(napi_env, napi_callback_info);
typedef int (*napi_create_buffer_copy_fn)(napi_env, size_t, const void*, void**, napi_value*);
typedef int (*napi_create_function_fn)(napi_env, const char*, size_t, napi_callback, void*, napi_value*);
typedef int (*napi_create_string_utf8_fn)(napi_env, const char*, size_t, napi_value*);
typedef int (*napi_get_boolean_fn)(napi_env, bool, napi_value*);
typedef int (*napi_get_cb_info_fn)(napi_env, napi_callback_info, size_t*, napi_value*, napi_value*, void**);
typedef int (*napi_get_undefined_fn)(napi_env, napi_value*);
typedef int (*napi_get_value_string_utf8_fn)(napi_env, napi_value, char*, size_t, size_t*);
typedef int (*napi_set_named_property_fn)(napi_env, napi_value, const char*, napi_value);
typedef int (*napi_throw_error_fn)(napi_env, const char*, const char*);

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

static CGEventFlags modifier_mask_for_name(const char* name) {
    if (strcmp(name, "shift") == 0) return kCGEventFlagMaskShift;
    if (strcmp(name, "command") == 0) return kCGEventFlagMaskCommand;
    if (strcmp(name, "control") == 0) return kCGEventFlagMaskControl;
    if (strcmp(name, "option") == 0) return kCGEventFlagMaskAlternate;
    return 0;
}

static napi_value is_modifier_pressed(napi_env env, napi_callback_info info) {
    napi_get_cb_info_fn napi_get_cb_info = (napi_get_cb_info_fn)node_symbol("napi_get_cb_info");
    napi_get_value_string_utf8_fn napi_get_value_string_utf8 =
        (napi_get_value_string_utf8_fn)node_symbol("napi_get_value_string_utf8");
    napi_get_boolean_fn napi_get_boolean = (napi_get_boolean_fn)node_symbol("napi_get_boolean");

    bool pressed = false;
    if (napi_get_cb_info && napi_get_value_string_utf8) {
        size_t argc = 1;
        napi_value args[1] = {0};
        if (napi_get_cb_info(env, info, &argc, args, 0, 0) == 0 && argc >= 1 && args[0]) {
            char name[16] = {0};
            size_t copied = 0;
            if (napi_get_value_string_utf8(env, args[0], name, sizeof(name), &copied) == 0) {
                CGEventFlags mask = modifier_mask_for_name(name);
                if (mask != 0) {
                    CGEventFlags flags = CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState);
                    pressed = (flags & mask) != 0;
                }
            }
        }
    }

    napi_value result = 0;
    if (!napi_get_boolean || napi_get_boolean(env, pressed, &result) != 0) {
        return fail(env, "Could not inspect modifier state");
    }
    return result;
}

static napi_value get_clipboard_text(napi_env env, napi_callback_info info) {
    (void)info;
    @autoreleasepool {
        NSString* text = [[NSPasteboard generalPasteboard] stringForType:NSPasteboardTypeString];
        if (!text) return fail(env, "Clipboard does not contain text");

        const char* utf8 = text.UTF8String;
        if (!utf8) return fail(env, "Could not encode clipboard text");

        napi_create_string_utf8_fn napi_create_string_utf8 =
            (napi_create_string_utf8_fn)node_symbol("napi_create_string_utf8");
        napi_value result = 0;
        size_t length = [text lengthOfBytesUsingEncoding:NSUTF8StringEncoding];
        if (!napi_create_string_utf8 || napi_create_string_utf8(env, utf8, length, &result) != 0) {
            return fail(env, "Could not create clipboard text");
        }
        return result;
    }
}

static napi_value set_clipboard_text(napi_env env, napi_callback_info info) {
    napi_get_cb_info_fn napi_get_cb_info = (napi_get_cb_info_fn)node_symbol("napi_get_cb_info");
    napi_get_value_string_utf8_fn napi_get_value_string_utf8 =
        (napi_get_value_string_utf8_fn)node_symbol("napi_get_value_string_utf8");
    size_t argc = 1;
    napi_value args[1] = {0};
    if (!napi_get_cb_info || !napi_get_value_string_utf8 ||
        napi_get_cb_info(env, info, &argc, args, 0, 0) != 0 || argc < 1 || !args[0]) {
        return fail(env, "setClipboardText requires a string");
    }

    size_t length = 0;
    if (napi_get_value_string_utf8(env, args[0], 0, 0, &length) != 0) {
        return fail(env, "setClipboardText requires a string");
    }
    char* utf8 = malloc(length + 1);
    if (!utf8) return fail(env, "Out of memory");
    if (napi_get_value_string_utf8(env, args[0], utf8, length + 1, &length) != 0) {
        free(utf8);
        return fail(env, "Could not read clipboard text");
    }

    @autoreleasepool {
        NSString* text = [[NSString alloc] initWithBytes:utf8 length:length encoding:NSUTF8StringEncoding];
        free(utf8);
        if (!text) return fail(env, "Clipboard text is not valid UTF-8");

        NSPasteboard* pasteboard = [NSPasteboard generalPasteboard];
        [pasteboard clearContents];
        if (![pasteboard setString:text forType:NSPasteboardTypeString]) {
            return fail(env, "Could not set clipboard text");
        }
    }
    return undefined_value(env);
}

static napi_value has_clipboard_image(napi_env env, napi_callback_info info) {
    (void)info;
    bool available = false;
    @autoreleasepool {
        NSArray* types = @[ NSPasteboardTypePNG, NSPasteboardTypeTIFF ];
        available = [[NSPasteboard generalPasteboard] availableTypeFromArray:types] != nil;
    }

    napi_get_boolean_fn napi_get_boolean = (napi_get_boolean_fn)node_symbol("napi_get_boolean");
    napi_value result = 0;
    if (!napi_get_boolean || napi_get_boolean(env, available, &result) != 0) {
        return fail(env, "Could not inspect clipboard");
    }
    return result;
}

static napi_value get_clipboard_image(napi_env env, napi_callback_info info) {
    (void)info;
    @autoreleasepool {
        NSPasteboard* pasteboard = [NSPasteboard generalPasteboard];
        NSData* png = [pasteboard dataForType:NSPasteboardTypePNG];
        if (!png) {
            NSImage* image = [[NSImage alloc] initWithPasteboard:pasteboard];
            NSData* tiff = image.TIFFRepresentation;
            NSBitmapImageRep* bitmap = tiff ? [NSBitmapImageRep imageRepWithData:tiff] : nil;
            png = bitmap ? [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] : nil;
        }
        if (!png) return fail(env, "Clipboard does not contain an image");

        napi_create_buffer_copy_fn napi_create_buffer_copy =
            (napi_create_buffer_copy_fn)node_symbol("napi_create_buffer_copy");
        napi_value result = 0;
        if (!napi_create_buffer_copy || napi_create_buffer_copy(env, png.length, png.bytes, 0, &result) != 0) {
            return fail(env, "Could not create clipboard image buffer");
        }
        return result;
    }
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
    set_function_export(env, exports, "isModifierPressed", is_modifier_pressed);
    set_function_export(env, exports, "getClipboardText", get_clipboard_text);
    set_function_export(env, exports, "setClipboardText", set_clipboard_text);
    set_function_export(env, exports, "hasClipboardImage", has_clipboard_image);
    set_function_export(env, exports, "getClipboardImage", get_clipboard_image);
    return exports;
}
