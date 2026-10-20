// The bundled keys plugin: desktop key bindings for the web client, in its page module (page.ts). Turn it off on a
// device like any plugin, and the page keeps only its own keys.
import { definePlugin } from "../../plugin.ts";

export default definePlugin((monchu) => {
  monchu.registerPage();
});
