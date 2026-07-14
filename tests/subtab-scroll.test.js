import test from "node:test";
import assert from "node:assert/strict";
import { centeredSubtabScrollLeft } from "../src/views/app-view.js";

test("active tabs are horizontally centered and clamped inside the tab strip", () => {
  assert.equal(centeredSubtabScrollLeft({ scrollWidth: 600, clientWidth: 200 }, { offsetLeft: 400, offsetWidth: 60 }), 330);
  assert.equal(centeredSubtabScrollLeft({ scrollWidth: 600, clientWidth: 200 }, { offsetLeft: 0, offsetWidth: 60 }), 0);
  assert.equal(centeredSubtabScrollLeft({ scrollWidth: 600, clientWidth: 200 }, { offsetLeft: 570, offsetWidth: 60 }), 400);
});
