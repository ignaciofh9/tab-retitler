// Injected into a tab by the settings page. Highlights elements under the
// mouse, works out a CSS selector for the one you click, and sends it back.

(() => {
  if (self.__tabRetitlerPicking) return;
  self.__tabRetitlerPicking = true;

  // Selector generation lives in shared.js, injected just before this file.
  const bestSelector = TR.bestSelector;

  // textContent, not innerText, to match what content.js reads later.
  const textOf = (el) => (el.textContent ?? "").replace(/\s+/g, " ").trim();

  // ---------- Overlay ----------

  const host = document.createElement("tab-retitler-picker");
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
      .box {
        position: fixed; pointer-events: none; z-index: 2147483646;
        border: 2px solid #3b6cf6; background: rgb(59 108 246 / 0.12); border-radius: 4px;
        transition: all 60ms ease-out; display: none;
      }
      .label {
        position: fixed; pointer-events: none; z-index: 2147483647; display: none;
        max-width: min(520px, calc(100vw - 16px));
        background: #1b1b19; color: #f2f2f0; border-radius: 8px; padding: 7px 10px;
        font-size: 12px; line-height: 1.4; box-shadow: 0 6px 24px rgb(0 0 0 / 0.3);
      }
      .sel { font-family: ui-monospace, "SF Mono", Menlo, monospace; color: #9db4ff; word-break: break-all; }
      .txt { color: #c9c9c4; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .bar {
        white-space: nowrap; max-width: calc(100vw - 24px);
        position: fixed; top: 14px; left: 50%; transform: translateX(-50%); z-index: 2147483647;
        display: flex; align-items: center; gap: 14px;
        background: #fff; color: #1b1b19; border-radius: 12px; padding: 8px 8px 8px 14px;
        font-size: 13px; box-shadow: 0 8px 30px rgb(0 0 0 / 0.22), 0 0 0 1px rgb(0 0 0 / 0.06);
      }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #3b6cf6; box-shadow: 0 0 0 4px rgb(59 108 246 / 0.2); }
      kbd {
        font-family: inherit; font-size: 11px; background: #f1f1ef; border: 1px solid #e0e0dc;
        border-bottom-width: 2px; border-radius: 4px; padding: 0 5px;
      }
      .hint { color: #6b6b66; }
      button {
        font: inherit; font-weight: 600; border: 0; border-radius: 8px; padding: 6px 12px; cursor: pointer;
        background: #f1f1ef; color: #1b1b19;
      }
      button:hover { background: #e6e6e2; }
      @media (max-width: 640px) { .hint { display: none; } }
      @media (prefers-color-scheme: dark) {
        .bar { background: #252524; color: #ececea; box-shadow: 0 8px 30px rgb(0 0 0 / 0.5), 0 0 0 1px rgb(255 255 255 / 0.08); }
        kbd { background: #1c1c1b; border-color: #3d3d3a; color: #ececea; }
        .hint { color: #a3a39e; }
        button { background: #35352f; color: #ececea; }
        button:hover { background: #42423c; }
      }
    </style>
    <div class="box"></div>
    <div class="label"><div class="sel"></div><div class="txt"></div></div>
    <div class="bar">
      <span class="dot"></span>
      <span><b>Click the element to read from</b></span>
      <span class="hint"><kbd>↑</kbd> <kbd>↓</kbd> wider or narrower · <kbd>Esc</kbd> cancel</span>
      <button type="button">Cancel</button>
    </div>`;
  const box = root.querySelector(".box");
  const label = root.querySelector(".label");
  const bar = root.querySelector(".bar");
  document.documentElement.append(host);

  let hovered = null;   // element under the mouse
  let current = null;   // hovered, or an ancestor of it after pressing ↑
  let trail = [];       // elements stepped up from, for ↓

  function show(el) {
    current = el;
    if (!el) {
      box.style.display = label.style.display = "none";
      return;
    }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, { display: "block", left: `${r.left - 2}px`, top: `${r.top - 2}px`, width: `${r.width + 4}px`, height: `${r.height + 4}px` });

    const text = textOf(el);
    label.querySelector(".sel").textContent = bestSelector(el);
    label.querySelector(".txt").textContent = text ? `“${text.slice(0, 120)}”` : "No text";
    label.style.display = "block";
    const lh = label.offsetHeight;
    const below = r.bottom + 8 + lh < innerHeight;
    label.style.top = `${below ? r.bottom + 8 : Math.max(8, r.top - lh - 8)}px`;
    label.style.left = `${Math.min(Math.max(8, r.left), innerWidth - label.offsetWidth - 8)}px`;
  }

  const isOurs = (el) => el === host;

  function onMove(e) {
    const el = e.target;
    if (isOurs(el) || el === hovered) return;
    hovered = el;
    trail = [];
    show(el);
  }

  // Stop the page from reacting to clicks while picking.
  function swallow(e) {
    if (isOurs(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onClick(e) {
    if (isOurs(e.target)) return;
    swallow(e);
    if (current) finish(current);
  }

  function onKey(e) {
    if (e.key === "Escape") return swallowKey(e), cancel();
    if (!current) return;
    if (e.key === "ArrowUp" && current.parentElement && current.parentElement !== document.documentElement) {
      swallowKey(e);
      trail.push(current);
      show(current.parentElement);
    } else if (e.key === "ArrowDown" && trail.length) {
      swallowKey(e);
      show(trail.pop());
    } else if (e.key === "Enter") {
      swallowKey(e);
      finish(current);
    }
  }
  function swallowKey(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  const onScroll = () => current && show(current);

  const listeners = [
    ["mousemove", onMove],
    ["mouseover", onMove],
    ["click", onClick],
    ["mousedown", swallow],
    ["mouseup", swallow],
    ["pointerdown", swallow],
    ["pointerup", swallow],
    ["auxclick", swallow],
    ["dblclick", swallow],
    ["keydown", onKey],
    ["scroll", onScroll],
  ];
  for (const [type, fn] of listeners) window.addEventListener(type, fn, true);
  bar.querySelector("button").addEventListener("click", cancel);

  function teardown() {
    for (const [type, fn] of listeners) window.removeEventListener(type, fn, true);
    host.remove();
    self.__tabRetitlerPicking = false;
  }

  function finish(el) {
    const message = { type: "element-picked", selector: bestSelector(el), text: textOf(el).slice(0, 500) };
    teardown();
    chrome.runtime.sendMessage(message).catch(() => {});
  }

  function cancel() {
    teardown();
    chrome.runtime.sendMessage({ type: "element-pick-cancelled" }).catch(() => {});
  }
})();
