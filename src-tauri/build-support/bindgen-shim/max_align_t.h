/* Build-support shim for bindgen parsing ONLY. Never compiled into code.
 *
 * Why: the pip `libclang` wheel ships only libclang.dll, without clang's
 * builtin resource headers. Clang therefore resolves <stddef.h> to the UCRT
 * copy, which does not define `max_align_t` — but `mupdf-sys` allowlists that
 * type and the `mupdf` crate references it, so binding generation silently
 * drops it and the `mupdf` crate fails with E0425.
 *
 * This force-include (`-include` via BINDGEN_EXTRA_CLANG_ARGS) provides the
 * MSVC-compatible definition (double: size 8, alignment 8 on x64, matching
 * MSVC's own max_align_t) purely so bindgen emits the binding.
 *
 * Only needed on Windows setups using the header-less pip libclang. Full LLVM
 * installs (and Linux/macOS toolchains) resolve their own stddef.h with
 * max_align_t and must NOT set the -include flag.
 */
#ifndef VEDITOR_BINDGEN_MAX_ALIGN_T
#define VEDITOR_BINDGEN_MAX_ALIGN_T
typedef double max_align_t;
#endif
