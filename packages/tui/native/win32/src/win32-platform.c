#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define WINAPI __stdcall
#define STD_INPUT_HANDLE ((uint32_t)-10)
#define INVALID_HANDLE_VALUE ((void*)(intptr_t)-1)
#define ENABLE_VIRTUAL_TERMINAL_INPUT 0x0200
#define VK_SHIFT 0x10
#define VK_CONTROL 0x11
#define VK_MENU 0x12
#define VK_LSHIFT 0xa0
#define VK_RSHIFT 0xa1
#define VK_LCONTROL 0xa2
#define VK_RCONTROL 0xa3
#define VK_LMENU 0xa4
#define VK_RMENU 0xa5
#define VK_LWIN 0x5b
#define VK_RWIN 0x5c
#define GMEM_FIXED 0x0000
#define GMEM_MOVEABLE 0x0002
#define CF_UNICODETEXT 13
#define CF_DIB 8
#define CF_DIBV5 17
#define BI_BITFIELDS 3
#define BI_ALPHABITFIELDS 6
#define TRUE 1
#define NAPI_AUTO_LENGTH ((size_t)-1)
#define KEY_PRESSED_MASK 0x8000
#define OPEN_CLIPBOARD_ATTEMPTS 10
#define OPEN_CLIPBOARD_RETRY_MS 5
#define BITMAP_FILE_HEADER_SIZE 14

typedef int BOOL;
typedef int16_t SHORT;
typedef uint32_t DWORD;
typedef uint32_t UINT;
typedef void* HANDLE;
typedef void* HGLOBAL;
typedef void* HINSTANCE;
typedef void* HMODULE;
typedef void* LPVOID;
typedef void (__stdcall *FARPROC)(void);

__declspec(dllimport) BOOL WINAPI CloseClipboard(void);
__declspec(dllimport) BOOL WINAPI EmptyClipboard(void);
__declspec(dllimport) HANDLE WINAPI GetClipboardData(UINT format);
__declspec(dllimport) BOOL WINAPI GetConsoleMode(HANDLE console, DWORD* mode);
__declspec(dllimport) HMODULE WINAPI GetModuleHandleA(const char* module_name);
__declspec(dllimport) FARPROC WINAPI GetProcAddress(HMODULE module, const char* name);
__declspec(dllimport) HANDLE WINAPI GetStdHandle(DWORD standard_handle);
__declspec(dllimport) HGLOBAL WINAPI GlobalAlloc(UINT flags, size_t bytes);
__declspec(dllimport) HGLOBAL WINAPI GlobalFree(HGLOBAL memory);
__declspec(dllimport) void* WINAPI GlobalLock(HGLOBAL memory);
__declspec(dllimport) size_t WINAPI GlobalSize(HGLOBAL memory);
__declspec(dllimport) BOOL WINAPI GlobalUnlock(HGLOBAL memory);
__declspec(dllimport) BOOL WINAPI IsClipboardFormatAvailable(UINT format);
__declspec(dllimport) HMODULE WINAPI LoadLibraryA(const char* library_name);
__declspec(dllimport) BOOL WINAPI OpenClipboard(void* owner);
__declspec(dllimport) UINT WINAPI RegisterClipboardFormatW(const uint16_t* format_name);
__declspec(dllimport) HANDLE WINAPI SetClipboardData(UINT format, HANDLE memory);
__declspec(dllimport) BOOL WINAPI SetConsoleMode(HANDLE console, DWORD mode);
__declspec(dllimport) void WINAPI Sleep(DWORD milliseconds);

typedef void* napi_env;
typedef void* napi_value;
typedef void* napi_callback_info;
typedef napi_value (__cdecl *napi_callback)(napi_env, napi_callback_info);
typedef int (__cdecl *napi_create_buffer_copy_fn)(napi_env, size_t, const void*, void**, napi_value*);
typedef int (__cdecl *napi_create_function_fn)(napi_env, const char*, size_t, napi_callback, void*, napi_value*);
typedef int (__cdecl *napi_create_string_utf16_fn)(napi_env, const uint16_t*, size_t, napi_value*);
typedef int (__cdecl *napi_get_boolean_fn)(napi_env, bool, napi_value*);
typedef int (__cdecl *napi_get_cb_info_fn)(napi_env, napi_callback_info, size_t*, napi_value*, napi_value*, void**);
typedef int (__cdecl *napi_get_undefined_fn)(napi_env, napi_value*);
typedef int (__cdecl *napi_get_value_string_utf16_fn)(napi_env, napi_value, uint16_t*, size_t, size_t*);
typedef int (__cdecl *napi_get_value_string_utf8_fn)(napi_env, napi_value, char*, size_t, size_t*);
typedef int (__cdecl *napi_set_named_property_fn)(napi_env, napi_value, const char*, napi_value);
typedef int (__cdecl *napi_throw_error_fn)(napi_env, const char*, const char*);
typedef SHORT (WINAPI *get_async_key_state_fn)(int);

static void* node_symbol(const char* name) {
    HMODULE module = GetModuleHandleA(0);
    void* proc = module ? (void*)GetProcAddress(module, name) : 0;
    if (proc) return proc;

    module = GetModuleHandleA("node.dll");
    return module ? (void*)GetProcAddress(module, name) : 0;
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

static int string_equals(const char* left, const char* right) {
    while (*left && *right && *left == *right) {
        left++;
        right++;
    }
    return *left == 0 && *right == 0;
}

static get_async_key_state_fn get_async_key_state_symbol(void) {
    static int loaded = 0;
    static get_async_key_state_fn get_async_key_state = 0;

    if (!loaded) {
        HMODULE module = GetModuleHandleA("user32.dll");
        if (!module) module = LoadLibraryA("user32.dll");
        get_async_key_state = module ? (get_async_key_state_fn)GetProcAddress(module, "GetAsyncKeyState") : 0;
        loaded = 1;
    }

    return get_async_key_state;
}

static int is_key_pressed(int virtual_key) {
    get_async_key_state_fn get_async_key_state = get_async_key_state_symbol();
    return get_async_key_state && (((unsigned short)get_async_key_state(virtual_key)) & KEY_PRESSED_MASK) != 0;
}

static int is_modifier_name_pressed(const char* name) {
    if (string_equals(name, "shift")) return is_key_pressed(VK_SHIFT) || is_key_pressed(VK_LSHIFT) || is_key_pressed(VK_RSHIFT);
    if (string_equals(name, "control")) return is_key_pressed(VK_CONTROL) || is_key_pressed(VK_LCONTROL) || is_key_pressed(VK_RCONTROL);
    if (string_equals(name, "option") || string_equals(name, "alt")) return is_key_pressed(VK_MENU) || is_key_pressed(VK_LMENU) || is_key_pressed(VK_RMENU);
    if (string_equals(name, "command") || string_equals(name, "super") || string_equals(name, "win")) return is_key_pressed(VK_LWIN) || is_key_pressed(VK_RWIN);
    return 0;
}

static napi_value __cdecl enable_virtual_terminal_input(napi_env env, napi_callback_info info) {
    (void)info;

    HANDLE handle = GetStdHandle(STD_INPUT_HANDLE);
    DWORD mode = 0;
    bool enabled = handle != INVALID_HANDLE_VALUE &&
        GetConsoleMode(handle, &mode) &&
        SetConsoleMode(handle, mode | ENABLE_VIRTUAL_TERMINAL_INPUT);

    napi_get_boolean_fn napi_get_boolean = (napi_get_boolean_fn)node_symbol("napi_get_boolean");
    napi_value result = 0;
    if (!napi_get_boolean || napi_get_boolean(env, enabled, &result) != 0) {
        return fail(env, "Could not configure console input");
    }
    return result;
}

static napi_value __cdecl is_modifier_pressed(napi_env env, napi_callback_info info) {
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
                pressed = is_modifier_name_pressed(name);
            }
        }
    }

    napi_value result = 0;
    if (!napi_get_boolean || napi_get_boolean(env, pressed, &result) != 0) {
        return fail(env, "Could not inspect modifier state");
    }
    return result;
}

static bool open_clipboard(void) {
    for (int attempt = 0; attempt < OPEN_CLIPBOARD_ATTEMPTS; attempt++) {
        if (OpenClipboard(0)) return true;
        Sleep(OPEN_CLIPBOARD_RETRY_MS);
    }
    return false;
}

static napi_value __cdecl get_clipboard_text(napi_env env, napi_callback_info info) {
    (void)info;
    if (!open_clipboard()) return fail(env, "Could not open clipboard");

    HGLOBAL handle = (HGLOBAL)GetClipboardData(CF_UNICODETEXT);
    const uint16_t* text = handle ? (const uint16_t*)GlobalLock(handle) : 0;
    if (!text) {
        CloseClipboard();
        return fail(env, "Clipboard does not contain text");
    }

    size_t capacity = GlobalSize(handle) / sizeof(uint16_t);
    size_t length = 0;
    while (length < capacity && text[length]) length++;

    napi_create_string_utf16_fn napi_create_string_utf16 =
        (napi_create_string_utf16_fn)node_symbol("napi_create_string_utf16");
    napi_value result = 0;
    int status = napi_create_string_utf16 ? napi_create_string_utf16(env, text, length, &result) : 1;
    GlobalUnlock(handle);
    CloseClipboard();

    return status == 0 ? result : fail(env, "Could not create clipboard text");
}

static napi_value __cdecl set_clipboard_text(napi_env env, napi_callback_info info) {
    napi_get_cb_info_fn napi_get_cb_info = (napi_get_cb_info_fn)node_symbol("napi_get_cb_info");
    napi_get_value_string_utf16_fn napi_get_value_string_utf16 =
        (napi_get_value_string_utf16_fn)node_symbol("napi_get_value_string_utf16");
    size_t argc = 1;
    napi_value args[1] = {0};
    size_t length = 0;
    if (!napi_get_cb_info || !napi_get_value_string_utf16 ||
        napi_get_cb_info(env, info, &argc, args, 0, 0) != 0 || argc < 1 || !args[0] ||
        napi_get_value_string_utf16(env, args[0], 0, 0, &length) != 0) {
        return fail(env, "setClipboardText requires a string");
    }

    HGLOBAL handle = GlobalAlloc(GMEM_MOVEABLE, (length + 1) * sizeof(uint16_t));
    uint16_t* text = handle ? (uint16_t*)GlobalLock(handle) : 0;
    if (!text) {
        if (handle) GlobalFree(handle);
        return fail(env, "Out of memory");
    }
    if (napi_get_value_string_utf16(env, args[0], text, length + 1, &length) != 0) {
        GlobalUnlock(handle);
        GlobalFree(handle);
        return fail(env, "Could not read clipboard text");
    }
    text[length] = 0;
    GlobalUnlock(handle);

    if (!open_clipboard()) {
        GlobalFree(handle);
        return fail(env, "Could not open clipboard");
    }
    bool success = EmptyClipboard() && SetClipboardData(CF_UNICODETEXT, handle) != 0;
    CloseClipboard();
    if (!success) {
        GlobalFree(handle);
        return fail(env, "Could not set clipboard text");
    }
    return undefined_value(env);
}

static UINT png_clipboard_format(void) {
    static const uint16_t png_name[] = {'P', 'N', 'G', 0};
    static UINT format = 0;
    if (!format) format = RegisterClipboardFormatW(png_name);
    return format;
}

static napi_value __cdecl has_clipboard_image(napi_env env, napi_callback_info info) {
    (void)info;
    UINT png_format = png_clipboard_format();
    bool available = (png_format && IsClipboardFormatAvailable(png_format)) ||
        IsClipboardFormatAvailable(CF_DIBV5) ||
        IsClipboardFormatAvailable(CF_DIB);

    napi_get_boolean_fn napi_get_boolean = (napi_get_boolean_fn)node_symbol("napi_get_boolean");
    napi_value result = 0;
    if (!napi_get_boolean || napi_get_boolean(env, available, &result) != 0) {
        return fail(env, "Could not inspect clipboard");
    }
    return result;
}

static uint16_t read_u16(const uint8_t* data) {
    return (uint16_t)data[0] | ((uint16_t)data[1] << 8);
}

static uint32_t read_u32(const uint8_t* data) {
    return (uint32_t)data[0] |
        ((uint32_t)data[1] << 8) |
        ((uint32_t)data[2] << 16) |
        ((uint32_t)data[3] << 24);
}

static void write_u32(uint8_t* data, uint32_t value) {
    data[0] = (uint8_t)value;
    data[1] = (uint8_t)(value >> 8);
    data[2] = (uint8_t)(value >> 16);
    data[3] = (uint8_t)(value >> 24);
}

static void copy_bytes(uint8_t* destination, const uint8_t* source, size_t length) {
    volatile uint8_t* target = destination;
    const volatile uint8_t* input = source;
    for (size_t index = 0; index < length; index++) target[index] = input[index];
}

static size_t dib_pixel_offset(const uint8_t* dib, size_t size) {
    if (size < 12) return 0;
    uint32_t header_size = read_u32(dib);

    if (header_size == 12) {
        uint16_t bits_per_pixel = read_u16(dib + 10);
        uint32_t color_count = bits_per_pixel <= 8 ? 1u << bits_per_pixel : 0;
        size_t offset = header_size + (size_t)color_count * 3;
        return offset <= size ? offset : 0;
    }

    if (header_size < 40 || header_size > size) return 0;
    uint16_t bits_per_pixel = read_u16(dib + 14);
    uint32_t compression = read_u32(dib + 16);
    uint32_t color_count = read_u32(dib + 32);
    if (!color_count && bits_per_pixel <= 8) color_count = 1u << bits_per_pixel;

    size_t offset = header_size + (size_t)color_count * 4;
    if (header_size == 40 && compression == BI_BITFIELDS) offset += 3 * sizeof(uint32_t);
    if (header_size == 40 && compression == BI_ALPHABITFIELDS) offset += 4 * sizeof(uint32_t);
    return offset <= size ? offset : 0;
}

static napi_value __cdecl get_clipboard_image(napi_env env, napi_callback_info info) {
    (void)info;
    if (!open_clipboard()) return fail(env, "Could not open clipboard");

    UINT png_format = png_clipboard_format();
    HGLOBAL handle = png_format && IsClipboardFormatAvailable(png_format)
        ? (HGLOBAL)GetClipboardData(png_format)
        : 0;
    bool is_png = handle != 0;
    if (!handle && IsClipboardFormatAvailable(CF_DIBV5)) {
        handle = (HGLOBAL)GetClipboardData(CF_DIBV5);
    }
    if (!handle && IsClipboardFormatAvailable(CF_DIB)) {
        handle = (HGLOBAL)GetClipboardData(CF_DIB);
    }

    const uint8_t* source = handle ? (const uint8_t*)GlobalLock(handle) : 0;
    size_t source_size = handle ? GlobalSize(handle) : 0;
    if (!source || !source_size) {
        if (source) GlobalUnlock(handle);
        CloseClipboard();
        return fail(env, "Clipboard does not contain an image");
    }

    napi_create_buffer_copy_fn napi_create_buffer_copy =
        (napi_create_buffer_copy_fn)node_symbol("napi_create_buffer_copy");
    napi_value result = 0;
    int status = 1;
    if (is_png) {
        if (napi_create_buffer_copy) {
            status = napi_create_buffer_copy(env, source_size, source, 0, &result);
        }
    } else {
        size_t pixel_offset = dib_pixel_offset(source, source_size);
        size_t total_size = source_size + BITMAP_FILE_HEADER_SIZE;
        uint8_t* bitmap = pixel_offset && source_size <= UINT32_MAX - BITMAP_FILE_HEADER_SIZE
            ? (uint8_t*)GlobalAlloc(GMEM_FIXED, total_size)
            : 0;
        if (bitmap) {
            bitmap[0] = 'B';
            bitmap[1] = 'M';
            write_u32(bitmap + 2, (uint32_t)total_size);
            write_u32(bitmap + 6, 0);
            write_u32(bitmap + 10, (uint32_t)(BITMAP_FILE_HEADER_SIZE + pixel_offset));
            copy_bytes(bitmap + BITMAP_FILE_HEADER_SIZE, source, source_size);
            if (napi_create_buffer_copy) {
                status = napi_create_buffer_copy(env, total_size, bitmap, 0, &result);
            }
            GlobalFree(bitmap);
        }
    }

    GlobalUnlock(handle);
    CloseClipboard();
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

BOOL WINAPI _DllMainCRTStartup(HINSTANCE instance, DWORD reason, LPVOID reserved) {
    (void)instance;
    (void)reason;
    (void)reserved;
    return TRUE;
}

__declspec(dllexport) napi_value __cdecl napi_register_module_v1(napi_env env, napi_value exports) {
    set_function_export(env, exports, "enableVirtualTerminalInput", enable_virtual_terminal_input);
    set_function_export(env, exports, "isModifierPressed", is_modifier_pressed);
    set_function_export(env, exports, "getClipboardText", get_clipboard_text);
    set_function_export(env, exports, "setClipboardText", set_clipboard_text);
    set_function_export(env, exports, "hasClipboardImage", has_clipboard_image);
    set_function_export(env, exports, "getClipboardImage", get_clipboard_image);
    return exports;
}
