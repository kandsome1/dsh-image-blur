/**
 * Host half of the `dsh-image-blur` bundle.
 *
 * Everything the plugin does happens in the browser: the Client module
 * (`./client`, declared by `dsh.client` in package.json) installs the blur
 * stylesheet, watches `<img>` nodes and draws the per-image 显示 / 模糊 button
 * inside the `shell.overlay` slot.
 *
 * There is deliberately no Host tool, no route and no Config here: blur is a
 * pure presentation effect, and a Host row that registers nothing keeps the
 * bundle loadable in every profile that has the Client UI, including ones
 * where the desktop-only services are missing.
 */

export function apply() {}
