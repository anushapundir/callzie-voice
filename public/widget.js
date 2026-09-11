/*
  The Talk-to-us widget (issue #45).

  One script tag on the business's own site:

    <script src="https://your-callzie-url/widget.js"
            data-callzie-key="czw_..."></script>

  Plain ES2020, no build step, no framework, no dependencies. It is served to
  strangers' browsers from other people's pages, so every byte here is a byte
  somebody else's site has to load — and anything that needed a bundler would
  make "one line of HTML" untrue.

  Three things it will not do, each on purpose:

  - **No microphone until the visitor presses Start.** A page that asks on load
    is a page people close. The permission prompt is attached to a deliberate
    click, and the AI disclosure is shown before it.
  - **No styling API beyond a colour and a label.** The whole value is that it is
    one line. A configuration surface is how that stops being true.
  - **Nothing outside its shadow root.** The host page's CSS cannot reach in and
    this cannot leak out — a widget that reflows somebody's checkout is worse
    than no widget.
*/
(function () {
  "use strict";

  var script = document.currentScript;
  if (!script) return;

  var key = script.getAttribute("data-callzie-key");
  if (!key) {
    // Loud, because the alternative is a button that silently never works and
    // an owner who assumes Callzie is broken.
    console.error("[callzie] widget.js needs a data-callzie-key attribute.");
    return;
  }

  // Derived from where the script was served, so a deployment never has to be
  // configured in two places.
  var origin = new URL(script.src, window.location.href).origin;
  var label = script.getAttribute("data-label") || "Talk to us";
  var accent = script.getAttribute("data-accent") || "#141311";

  var host = document.createElement("div");
  host.style.cssText =
    "position:fixed;right:16px;bottom:16px;z-index:2147483000";
  /*
    Closed, not open. The host page cannot reach in and rearrange this, which
    matters because the disclosure below is a claim Callzie makes on the
    business's behalf and it should not be removable by editing the page's CSS.
  */
  var root = host.attachShadow({ mode: "closed" });

  /*
    The tokens from app/globals.css, written out by hand.

    This file is served raw to somebody else's page, so it cannot import the
    stylesheet — but it is still the only piece of Callzie a customer ever sees,
    sitting on a site Callzie does not control. Before this it used `system-ui`,
    a 999px pill and two drop shadows, so it looked like a third-party bolt-on
    on every page it appeared on. Keep these six values in step with the tokens
    when the palette moves.

    The fonts are a stack, not a webfont: pulling Inter onto a stranger's page
    costs them a render-blocking request for one button.
  */
  var INK = cssSafe(accent);
  var PAPER = "#FAFAF7";
  var LINE = "#E2E0DA";
  var MUTED = "#6F6C64";
  var FONT =
    "'Inter','SF Pro Text',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";

  root.innerHTML = [
    "<style>",
    "  :host,*{box-sizing:border-box}",
    "  .btn{font:500 14px/1.4 " + FONT + ";border:1px solid transparent;",
    "    border-radius:4px;padding:9px 14px;color:" + PAPER + ";cursor:pointer;",
    "    background:" + INK + ";transition:background-color .15s ease}",
    "  .btn:hover{background:#2A2824}",
    "  .btn:focus-visible{outline:2px solid " + INK + ";outline-offset:2px}",
    "  .btn[disabled]{opacity:.5;cursor:default}",
    /*
      One hairline and one soft shadow, and the shadow is only on the panel —
      the thing that genuinely floats above the host page. The launcher sits on
      the page rather than hovering over it.
    */
    "  .panel{width:300px;background:" + PAPER + ";color:#141311;",
    "    border:1px solid " + LINE + ";border-radius:6px;padding:16px;",
    "    box-shadow:0 4px 12px rgba(0,0,0,.08);",
    "    font:400 14px/1.45 " + FONT + "}",
    "  .panel[hidden]{display:none}",
    "  #title{font-size:16px;font-weight:500;letter-spacing:-.01em}",
    "  .note{color:" + MUTED + ";font-size:13px;margin:8px 0 14px}",
    "  .row{display:flex;gap:8px}",
    "  .row button{flex:1}",
    "  .ghost{background:transparent;color:#141311;border-color:" + LINE + "}",
    "  .ghost:hover{background:#F4F3EF}",
    "  .status{margin-top:10px;font-size:13px;color:" + MUTED + ";min-height:18px}",
    "</style>",
    '<div class="panel" hidden part="panel">',
    '  <strong id="title">Talk to us</strong>',
    /*
      The disclosure, and it is not optional. Nearly half of consumers expect an
      AI voice to say so, and on a line the business owns the disclosure is
      cheap while its absence is a liability. It is shown before the microphone
      is requested, not after — being told what you are talking to has to happen
      before you start talking.
    */
    '  <p class="note">You will be talking to an AI assistant, not a person.',
    "    The call is recorded. Your browser will ask for microphone access.</p>",
    '  <div class="row">',
    '    <button class="btn" id="start">Start call</button>',
    '    <button class="btn ghost" id="close">Not now</button>',
    "  </div>",
    '  <p class="status" id="status"></p>',
    "</div>",
    '<button class="btn" id="open"></button>',
  ].join("\n");

  var panel = root.querySelector(".panel");
  var openBtn = root.querySelector("#open");
  var startBtn = root.querySelector("#start");
  var closeBtn = root.querySelector("#close");
  var status = root.querySelector("#status");

  // `textContent`, never `innerHTML`. The label comes off an attribute on
  // somebody else's page, and this is the one place an author-controlled string
  // meets the DOM.
  openBtn.textContent = label;
  root.querySelector("#title").textContent = label;

  openBtn.addEventListener("click", function () {
    panel.hidden = false;
    openBtn.hidden = true;
    startBtn.focus();
  });

  closeBtn.addEventListener("click", function () {
    panel.hidden = true;
    openBtn.hidden = false;
    openBtn.focus();
  });

  var live = null;

  startBtn.addEventListener("click", async function () {
    if (live) return;

    startBtn.disabled = true;
    status.textContent = "Connecting…";

    try {
      var response = await fetch(origin + "/api/widget/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: key }),
      });

      if (!response.ok) {
        /*
          The server refuses every reason identically, so there is nothing more
          specific to say here and inventing something would be guessing. This
          wording is chosen to be true of all of them — an unknown key, a spent
          allowance, a disabled account.
        */
        status.textContent =
          "We can't take calls right now. Please try the phone number on this page.";
        startBtn.disabled = false;
        return;
      }

      var token = (await response.json()).access_token;

      /*
        The Retell SDK is loaded only now, and only if a Call is actually
        starting. Every visitor who never presses the button pays nothing for
        it, which on somebody else's marketing page is the difference between a
        widget they keep and one they remove.
      */
      var sdk = await import(
        "https://esm.sh/retell-client-js-sdk@2.0.8"
      );
      live = new sdk.RetellWebClient();

      live.on("call_ended", function () {
        live = null;
        status.textContent = "Call ended.";
        startBtn.disabled = false;
      });
      live.on("error", function () {
        if (live) live.stopCall();
        live = null;
        status.textContent = "The call dropped. You can try again.";
        startBtn.disabled = false;
      });

      // This is where the browser asks for the microphone — on a deliberate
      // click, after the disclosure above has been read.
      await live.startCall({ accessToken: token });
      status.textContent = "Connected. Say hello.";
    } catch (error) {
      console.error("[callzie]", error);
      live = null;
      status.textContent = "We couldn't start the call.";
      startBtn.disabled = false;
    }
  });

  document.body.appendChild(host);

  /**
   * Keeps an author-supplied colour from escaping the CSS rule it lands in.
   *
   * `data-accent` comes off an attribute on a page Callzie does not control, and
   * it is interpolated into a stylesheet. A value containing a brace or a
   * semicolon could close the rule and open another — inside a closed shadow
   * root, which limits the blast radius but does not make it fine. Anything
   * that is not a plain colour is dropped rather than sanitised.
   */
  function cssSafe(value) {
    return /^#[0-9a-f]{3,8}$|^[a-z]+$/i.test(value) ? value : "#141311";
  }
})();
