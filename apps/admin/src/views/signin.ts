import { h, mount } from "../dom.js";
import { api, HttpError } from "../api.js";

type Mode = "signin" | "signup";

export function renderSignIn(root: HTMLElement): void {
  let status: "idle" | "sent" | "error" = "idle";
  let message = "";
  let mode: Mode = "signin";
  let signupAvailable = false;

  const draw = () => {
    const shell = h("div", { class: "signin-shell" });

    shell.appendChild(h("header", { class: "masthead" },
      h("h1", { class: "wordmark" }, "BulletinMail"),
    ));
    shell.appendChild(h("p", { class: "dateline" },
      mode === "signup" ? "First-time setup · Bootstrap admin" : "Sign in · Magic link",
    ));

    shell.appendChild(h("h2", null, mode === "signup" ? "Claim this instance" : "Sign in"));
    shell.appendChild(h("p", { class: "small muted" },
      mode === "signup"
        ? "First-time setup. Enter your email — we'll send you a sign-in link, and your account becomes the admin for this instance."
        : "Enter your email. We'll email you a one-time sign-in link.",
    ));

    if (status === "sent") {
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
      shell.appendChild(renderSignInForm((banner) => { status = banner.kind; message = banner.text; draw(); }));
      if (signupAvailable) {
        shell.appendChild(h("p", { class: "small muted" },
          "First time here? ",
          h("a", { href: "#", onclick: (ev: MouseEvent) => { ev.preventDefault(); mode = "signup"; status = "idle"; message = ""; draw(); } }, "Create the first admin"),
          ".",
        ));
      }
    } else {
      shell.appendChild(renderSignupForm((banner) => { status = banner.kind; message = banner.text; draw(); }));
      shell.appendChild(h("p", { class: "small muted" },
        "Already have an account? ",
        h("a", { href: "#", onclick: (ev: MouseEvent) => { ev.preventDefault(); mode = "signin"; status = "idle"; message = ""; draw(); } }, "Sign in instead"),
        ".",
      ));
    }

    mount(root, shell);
  };

  // Probe signup availability so the bootstrap form only appears on a fresh
  // instance. The endpoint is cheap (single COUNT(*)).
  api.signupAvailable()
    .then((res) => { signupAvailable = res.available; draw(); })
    .catch(() => { draw(); });

  draw();
}

type Banner = { kind: "sent" | "error"; text: string };

function renderSignInForm(setBanner: (b: Banner) => void): HTMLElement {
  const input = h("input", { type: "email", autocomplete: "email", required: "required", placeholder: "you@church.org" }) as HTMLInputElement;
  const submit = h("button", { class: "btn btn--primary", type: "submit" }, "Send link") as HTMLButtonElement;

  const form = h("form", {
    onsubmit: async (ev) => {
      ev.preventDefault();
      const email = input.value.trim();
      if (!email) return;
      submit.disabled = true;
      try {
        await api.requestMagicLink(email);
        setBanner({ kind: "sent", text: `If ${email} matches an admin, we just sent a sign-in link. Check your inbox.` });
      } catch (err) {
        if (err instanceof HttpError && err.status === 400) {
          setBanner({ kind: "error", text: "That doesn't look like a valid email." });
        } else {
          setBanner({ kind: "error", text: "Something went wrong. Try again in a minute." });
        }
      } finally {
        submit.disabled = false;
      }
    },
  },
    h("div", { class: "field-group" },
      h("label", null, "Email address"),
      input,
    ),
    submit,
  );
  setTimeout(() => input.focus(), 0);
  return form;
}

function renderSignupForm(setBanner: (b: Banner) => void): HTMLElement {
  const email = h("input", { type: "email", autocomplete: "email", required: "required", placeholder: "you@church.org" }) as HTMLInputElement;
  const submit = h("button", { class: "btn btn--primary", type: "submit" }, "Claim + send link") as HTMLButtonElement;

  const form = h("form", {
    onsubmit: async (ev) => {
      ev.preventDefault();
      const value = email.value.trim();
      if (!value) return;
      submit.disabled = true;
      try {
        await api.signup(value);
        setBanner({ kind: "sent", text: `Sign-in link sent to ${value}. Click it to finish bootstrapping.` });
      } catch (err) {
        if (err instanceof HttpError) {
          if (err.status === 403) {
            setBanner({ kind: "error", text: "Bootstrap is closed — an admin already exists." });
          } else if (err.status === 409) {
            setBanner({ kind: "error", text: "That email is already in use." });
          } else if (err.status === 400) {
            setBanner({ kind: "error", text: "That doesn't look like a valid email." });
          } else {
            setBanner({ kind: "error", text: "Bootstrap failed. Try again in a minute." });
          }
        } else {
          setBanner({ kind: "error", text: "Bootstrap failed. Try again in a minute." });
        }
      } finally {
        submit.disabled = false;
      }
    },
  },
    h("div", { class: "field-group" },
      h("label", null, "Your email"),
      email,
    ),
    submit,
  );
  setTimeout(() => email.focus(), 0);
  return form;
}
