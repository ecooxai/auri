import { AppController } from "./controllers/app-controller.js";
import { Backend } from "./services/backend.js";
import { AppView } from "./views/app-view.js";
import { TerminalSession } from "./services/terminal-session.js";

const root = document.querySelector("#app");
const view = new AppView(root);
const backend = new Backend();
// When this page is served by the Auri app's local web server (auri browser,
// port 8899), route native invokes over its HTTP bridge before booting.
await backend.connectHostedWebBridge();
const controller = new AppController({ view, backend, terminalSessionFactory: (value, actions) => new TerminalSession(value, actions) });

controller.initialize();
