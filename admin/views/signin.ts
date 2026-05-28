import { h, mount } from "../dom.js";
import { api, HttpError } from "../api.js";

type Mode = "signin" | "signup";
type Step = "email" | "code";

/**
 * Sign-in flow (two-step, optional Turnstile):
 *
 *   step "email":
 *     - Email field + Turnstile widget (only when /api/auth/config returns
 *       a site key — env-gated; dev mode skips the widget entirely).
 *     - Submit POSTs /api/auth/request. We never reveal whether the email
 *       matched. On 204 we advance to step "code".
 *
 *   step "code":
 *     - 6-digit input (inputmode="numeric", autocomplete="one-time-code"
 *       so iOS surfaces the code from the SMS/email suggestion bar).
 *     - Submit POSTs /api/auth/verify-code; on success we hard-navigate
 *       to the returned redirect (admin SPA root). On failure the user
 *       can retype or hit "Resend code".
 *     - "Resend code" reruns the email-step submission with the cached
 *       email + a fresh Turnstile token; the previous magic_links row
 *       expires in 15 minutes either way.
 *
 * Signup is unchanged (single-step), but inherits the same Turnstile
 * widget on its form so the bootstrap endpoint is also bot-protected when
 * the operator has configured a site key.
 */

declare global {
  interface Window {
    turnstile?: {
      render(
        el: HTMLElement,
        opts: {
          sitekey: string;
          callback?: (token: string) => void;
          "expired-callback"?: () => void;
          "error-callback"?: () => void;
        },
      ): string;
      reset(widgetId?: string): void;
      remove(widgetId?: string): void;
    };
  }
}

const TURNSTILE_SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js";

let turnstileScriptLoaded: Promise<void> | null = null;

function loadTurnstileScript(): Promise<void> {
  if (turnstileScriptLoaded) return turnstileScriptLoaded;
  turnstileScriptLoaded = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${TURNSTILE_SCRIPT_SRC}"]`,
    );
    if (existing && window.turnstile) return resolve();
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error("turnstile load failed")), { once: true });
      return;
    }
    const s = document.createElement("script");
    s.src = TURNSTILE_SCRIPT_SRC;
    s.async = true;
    s.defer = true;
    s.addEventListener("load", () => resolve(), { once: true });
    s.addEventListener("error", () => reject(new Error("turnstile load failed")), { once: true });
    document.head.appendChild(s);
  });
  return turnstileScriptLoaded;
}

export function renderSignIn(root: HTMLElement): void {
  let status: "idle" | "sent" | "error" = "idle";
  let message = "";
  let mode: Mode = "signin";
  let step: Step = "email";
  let signupAvailable = false;
  let turnstileSiteKey: string | null = null;
  let pendingEmail = "";

  const draw = () => {
    const shell = h("div", { class: "signin-shell" });

    shell.appendChild(h("header", { class: "masthead" },
      h("h1", { class: "wordmark" }, "BulletinMail"),
    ));
    shell.appendChild(h("p", { class: "dateline" },
      mode === "signup"
        ? "First-time setup · Bootstrap admin"
        : step === "code"
          ? "Sign in · Enter code"
          : "Sign in · Magic link",
    ));

    shell.appendChild(h("h2", null, mode === "signup" ? "Claim this instance" : "Sign in"));
    shell.appendChild(h("p", { class: "small muted" },
      mode === "signup"
        ? "First-time setup. Enter your email — we'll send you a sign-in link and a 6-digit code, and your account becomes the admin for this instance."
        : step === "code"
          ? `We emailed a 6-digit code to ${pendingEmail}. Enter it below, or click the link in the email.`
          : "Enter your email. We'll email you a one-time sign-in link and a 6-digit code you can paste here.",
    ));

    if (status === "sent" && step !== "code") {
      shell.appendChild(h("div", { class: "banner banner--ok" }, message));
      shell.appendChild(h("button", {
        class: "btn",
        onclick: () => { status = "idle"; message = ""; draw(); },
      }, "Use a different email"));
      mount(root, shell);
      return;
    }

    if (status === "error") {
      shell.appendChild(h("div", { class: "banner banner--alert" }, message));
    }

    if (mode === "signin") {
      if (step === "email") {
        shell.appendChild(renderSignInForm({
          turnstileSiteKey,
          onSent: (email) => {
            pendingEmail = email;
            status = "idle";
            message = "";
            step = "code";
            draw();
          },
          onBanner: (banner) => { status = banner.kind; message = banner.text; draw(); },
        }));
      } else {
        shell.appendChild(renderCodeForm({
          email: pendingEmail,
          turnstileSiteKey,
          onBack: () => { step = "email"; status = "idle"; message = ""; draw(); },
          onBanner: (banner) => { status = banner.kind; message = banner.text; draw(); },
        }));
      }
      if (step === "email" && signupAvailable) {
        shell.appendChild(h("p", { class: "small muted" },
          "First time here? ",
          h("a", { href: "#", onclick: (ev: MouseEvent) => { ev.preventDefault(); mode = "signup"; status = "idle"; message = ""; draw(); } }, "Create the first admin"),
          ".",
        ));
      }
    } else {
      shell.appendChild(renderSignupForm({
        turnstileSiteKey,
        onBanner: (banner) => { status = banner.kind; message = banner.text; draw(); },
      }));
      shell.appendChild(h("p", { class: "small muted" },
        "Already have an account? ",
        h("a", { href: "#", onclick: (ev: MouseEvent) => { ev.preventDefault(); mode = "signin"; status = "idle"; message = ""; draw(); } }, "Sign in instead"),
        ".",
      ));
    }

    mount(root, shell);
  };

  // Probe signup availability + auth config in parallel so the bootstrap
  // form only appears on a fresh instance and the Turnstile widget is
  // mounted iff the operator configured a site key. The endpoints are
  // cheap (single COUNT(*) and a constant) so a sequential fetch wouldn't
  // be much worse — but parallel keeps the first paint snappy.
  Promise.all([
    api.signupAvailable().then((res) => { signupAvailable = res.available; }).catch(() => {}),
    api.authConfig().then((res) => { turnstileSiteKey = res.turnstileSiteKey; }).catch(() => {}),
  ]).then(draw);

  draw();
}

type Banner = { kind: "sent" | "error"; text: string };

/**
 * Mount the Turnstile widget into `host`. Resolves with a getter for the
 * current token (re-invoked at submit time so we always send the freshest
 * token — Turnstile tokens are single-use). If the script fails to load
 * or the operator hasn't configured a site key, returns a getter that
 * yields undefined; the server bypass path handles that case.
 */
function mountTurnstile(
  host: HTMLElement,
  siteKey: string | null,
): { getToken(): string | undefined; reset(): void } {
  if (!siteKey) {
    return { getToken: () => undefined, reset: () => {} };
  }
  let token: string | undefined;
  let widgetId: string | undefined;
  loadTurnstileScript()
    .then(() => {
      if (!window.turnstile) return;
      widgetId = window.turnstile.render(host, {
        sitekey: siteKey,
        callback: (t) => { token = t; },
        "expired-callback": () => { token = undefined; },
        "error-callback": () => { token = undefined; },
      });
    })
    .catch(() => {
      host.appendChild(h("p", { class: "small muted" },
        "Couldn't load the human check. Try refreshing.",
      ));
    });
  return {
    getToken: () => token,
    reset: () => {
      if (widgetId && window.turnstile) window.turnstile.reset(widgetId);
      token = undefined;
    },
  };
}

function renderSignInForm(opts: {
  turnstileSiteKey: string | null;
  onSent: (email: string) => void;
  onBanner: (b: Banner) => void;
}): HTMLElement {
  const input = h("input", {
    type: "email",
    autocomplete: "email",
    required: "required",
    placeholder: "you@church.org",
    inputmode: "email",
  }) as HTMLInputElement;
  const submit = h("button", { class: "btn btn--primary", type: "submit" }, "Send code") as HTMLButtonElement;
  const turnstileHost = h("div", { class: "turnstile-host" });

  const form = h("form", {
    onsubmit: async (ev) => {
      ev.preventDefault();
      const email = input.value.trim();
      if (!email) return;
      submit.disabled = true;
      try {
        await api.requestMagicLink(email, ts.getToken());
        opts.onSent(email);
      } catch (err) {
        if (err instanceof HttpError && err.status === 400) {
          const payload = err.payload as { error?: string } | null;
          if (payload?.error === "human_check_failed") {
            opts.onBanner({ kind: "error", text: "Human check failed. Please try again." });
          } else {
            opts.onBanner({ kind: "error", text: "That doesn't look like a valid email." });
          }
        } else {
          opts.onBanner({ kind: "error", text: "Something went wrong. Try again in a minute." });
        }
        ts.reset();
      } finally {
        submit.disabled = false;
      }
    },
  },
    h("div", { class: "field-group" },
      h("label", null, "Email address"),
      input,
    ),
    turnstileHost,
    submit,
  );
  const ts = mountTurnstile(turnstileHost, opts.turnstileSiteKey);
  setTimeout(() => input.focus(), 0);
  return form;
}

function renderCodeForm(opts: {
  email: string;
  turnstileSiteKey: string | null;
  onBack: () => void;
  onBanner: (b: Banner) => void;
}): HTMLElement {
  const codeInput = h("input", {
    type: "text",
    inputmode: "numeric",
    autocomplete: "one-time-code",
    pattern: "\\d{6}",
    maxlength: "7", // allows "123 456"
    required: "required",
    placeholder: "123 456",
    "aria-label": "6-digit sign-in code",
  }) as HTMLInputElement;
  const submit = h("button", { class: "btn btn--primary", type: "submit" }, "Sign in") as HTMLButtonElement;
  let resending = false;

  const resendLink = h("a", {
    href: "#",
    onclick: async (ev: MouseEvent) => {
      ev.preventDefault();
      if (resending) return;
      resending = true;
      try {
        // Resend uses the same /request endpoint with the cached email.
        // We don't have a Turnstile widget mounted here — the operator's
        // bot protection ran on the initial request, and the surface
        // for resend is bounded by the 15-minute window. If Turnstile is
        // enforced we explicitly tell the user to start over.
        if (opts.turnstileSiteKey) {
          opts.onBack();
          opts.onBanner({ kind: "error", text: "Please re-verify the human check to receive a new code." });
          return;
        }
        await api.requestMagicLink(opts.email);
        opts.onBanner({ kind: "sent", text: `Sent a fresh code to ${opts.email}.` });
      } catch {
        opts.onBanner({ kind: "error", text: "Couldn't resend. Try again." });
      } finally {
        resending = false;
      }
    },
  }, "Resend code");

  const form = h("form", {
    onsubmit: async (ev) => {
      ev.preventDefault();
      const code = codeInput.value.replace(/\s/g, "");
      if (!/^\d{6}$/.test(code)) {
        opts.onBanner({ kind: "error", text: "Enter the 6-digit code from the email." });
        return;
      }
      submit.disabled = true;
      try {
        const res = await api.verifyCode(opts.email, code);
        // Hard-navigate so the SPA reboots and /api/me sees the fresh cookie.
        location.assign(res.redirect);
      } catch (err) {
        if (err instanceof HttpError && err.status === 400) {
          const payload = err.payload as { error?: string } | null;
          if (payload?.error === "invalid_code") {
            opts.onBanner({ kind: "error", text: "That code isn't valid (or already used / expired). Check the email or resend." });
          } else {
            opts.onBanner({ kind: "error", text: "That doesn't look like a valid email." });
          }
        } else {
          opts.onBanner({ kind: "error", text: "Something went wrong. Try again." });
        }
      } finally {
        submit.disabled = false;
      }
    },
  },
    h("div", { class: "field-group" },
      h("label", null, "6-digit code"),
      codeInput,
    ),
    submit,
    h("p", { class: "small muted" },
      h("a", {
        href: "#",
        onclick: (ev: MouseEvent) => { ev.preventDefault(); opts.onBack(); },
      }, "← Change email"),
      " · ",
      resendLink,
    ),
  );
  setTimeout(() => codeInput.focus(), 0);
  return form;
}

function renderSignupForm(opts: {
  turnstileSiteKey: string | null;
  onBanner: (b: Banner) => void;
}): HTMLElement {
  const email = h("input", {
    type: "email",
    autocomplete: "email",
    required: "required",
    placeholder: "you@church.org",
  }) as HTMLInputElement;
  const submit = h("button", { class: "btn btn--primary", type: "submit" }, "Claim + send link") as HTMLButtonElement;
  const turnstileHost = h("div", { class: "turnstile-host" });

  const form = h("form", {
    onsubmit: async (ev) => {
      ev.preventDefault();
      const value = email.value.trim();
      if (!value) return;
      submit.disabled = true;
      try {
        await api.signup(value);
        opts.onBanner({ kind: "sent", text: `Sign-in link sent to ${value}. Click it to finish bootstrapping.` });
      } catch (err) {
        if (err instanceof HttpError) {
          if (err.status === 403) {
            opts.onBanner({ kind: "error", text: "Bootstrap is closed — an admin already exists." });
          } else if (err.status === 409) {
            opts.onBanner({ kind: "error", text: "That email is already in use." });
          } else if (err.status === 400) {
            opts.onBanner({ kind: "error", text: "That doesn't look like a valid email." });
          } else {
            opts.onBanner({ kind: "error", text: "Bootstrap failed. Try again in a minute." });
          }
        } else {
          opts.onBanner({ kind: "error", text: "Bootstrap failed. Try again in a minute." });
        }
        ts.reset();
      } finally {
        submit.disabled = false;
      }
    },
  },
    h("div", { class: "field-group" },
      h("label", null, "Your email"),
      email,
    ),
    turnstileHost,
    submit,
  );
  const ts = mountTurnstile(turnstileHost, opts.turnstileSiteKey);
  setTimeout(() => email.focus(), 0);
  return form;
}
