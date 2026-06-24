import { AppController } from "./controllers/app-controller.js";
import { Backend } from "./services/backend.js";
import { AppView } from "./views/app-view.js";
import { TerminalSession } from "./services/terminal-session.js";

const root = document.querySelector("#app");
const view = new AppView(root);
const backend = new Backend();
const controller = new AppController({ view, backend, terminalSessionFactory: (value) => new TerminalSession(value) });

controller.initialize();
