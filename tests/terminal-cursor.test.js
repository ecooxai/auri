import test from "node:test";
import assert from "node:assert/strict";
import { TerminalSession } from "../src/services/terminal-session.js";

test("terminal cursor anchors vertically to the rendered row", () => {
  const session = new TerminalSession({ isNative: true });
  const cursor = { hidden: true, style: {} };
  const rows = [
    { offsetTop: 0, offsetHeight: 16 },
    { offsetTop: 16, offsetHeight: 16 },
    { offsetTop: 32, offsetHeight: 16 },
    { offsetTop: 48, offsetHeight: 16 }
  ];

  session.cellWidth = 7.5;
  // Deliberately disagree with the DOM rows. Linux/WebKit may round the
  // hidden font probe differently from the terminal row boxes.
  session.rowHeight = 13;
  session.cursorElement = cursor;
  session.screenElement = { querySelectorAll: () => rows };

  session.positionCursor({ cursorVisible: true, cursorX: 5, cursorY: 3 });

  assert.equal(cursor.hidden, false);
  assert.equal(cursor.style.left, "38px");
  assert.equal(cursor.style.top, "48px");
  assert.equal(cursor.style.height, "16px");
});
