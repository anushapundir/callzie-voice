import type { NextClerkProviderProps } from "@clerk/nextjs/types";

/*
  Clerk's components, wearing the app's design tokens rather than Clerk's
  defaults.

  Almost every value here is a `var(--…)` reference into the `@theme` block in
  app/globals.css, not a copied hex. Clerk renders outside our Tailwind tree but
  inside the same document, so the custom properties resolve — and the token set
  stays the single source of truth. A palette change in globals.css moves the
  sign-in screen with it; a hex pasted here would silently stop matching.

  `colorBackground` is the one exception, and the reason is worth knowing.
  Clerk does not just paint that value — it *computes* with it, deriving the
  hover washes and the disabled greys by mixing it with the foreground. Handed
  a `var(--…)` it cannot read, it falls back to pure white, and pure white next
  to warm paper reads as a rendering bug rather than a design choice. So that
  one value is the literal paper hex, and it has to be changed in two places if
  the paper ever changes.

  `variables` carries the palette, type scale, radii and the focus ring — note
  that `elements` keys are NOT type-checked (the union they resolve to defeats
  excess-property checking), so a misspelt one fails silently at runtime. Keep
  anything expressible as a variable in `variables`, and treat what is left as
  something to confirm in a browser rather than trust to the compiler.
*/
export const clerkTheme: NonNullable<NextClerkProviderProps["appearance"]> = {
  variables: {
    // Near-black, on primary actions only — the same restriction the design
    // system puts on the rest of the app.
    colorPrimary: "var(--color-accent)",
    colorPrimaryForeground: "var(--color-bg)",
    // Dark shades on a light theme: this drives borders and hover washes.
    colorNeutral: "var(--color-text)",
    // The paper token, written out. See the note at the top of the file — this
    // is the one value Clerk needs to be able to read, not just print.
    colorBackground: "#ffffff",
    colorForeground: "var(--color-text)",
    colorMuted: "var(--color-surface-card)",
    colorMutedForeground: "var(--color-text-muted)",
    colorInput: "var(--color-bg)",
    colorInputForeground: "var(--color-text)",
    colorBorder: "var(--color-line)",
    colorRing: "var(--color-accent)",
    colorShadow: "transparent",
    colorDanger: "var(--color-declined)",
    colorSuccess: "var(--color-confirmed)",
    colorWarning: "var(--color-attention)",
    // The scrim behind Clerk's modals: ink, washed down by Clerk itself.
    colorModalBackdrop: "var(--color-text)",

    fontFamily: "var(--font-outfit)",
    fontFamilyMono: "var(--font-jetbrains-mono)",
    /*
      Every step named, not just the base. Given a single value Clerk derives
      the rest by ratio and lands on sizes like 18.3px for a heading — off the
      four-size scale §11.2 fixes, which is exactly the "no font size outside
      the token set" rule. Five Clerk steps onto four tokens: `xs` and `sm`
      share the table size, since the scale has nothing below 13px.
    */
    fontSize: {
      xs: "var(--text-table)",
      sm: "var(--text-table)",
      md: "var(--text-body)",
      lg: "var(--text-section)",
      xl: "var(--text-page)",
    },
    // The control radius; Clerk scales the card's own radius up from this base.
    borderRadius: "var(--radius-control)",
    // Clerk's base spacing unit is one step, not one grid square — its default
    // is 1rem. Four squares of the 4px grid is the value that lands on it while
    // staying on the grid.
    spacing: "calc(var(--spacing) * 4)",
  },
  elements: {
    /*
      Clerk's card is a fixed 25rem, which is wider than a 375px viewport once
      the page gutters are taken off — it overflowed sideways at the low end of
      §11.4's range. Fluid up to that same 25rem instead, so the card is
      unchanged on a laptop and simply narrows on a phone.
    */
    rootBox: {
      width: "100%",
    },
    cardBox: {
      width: "100%",
      maxWidth: "25rem",
      // The card's outer wrapper, which Clerk rounds one step above the card
      // itself (12px). It has no fill of its own, so matching the card's radius
      // is invisible — but it keeps the audit honest: §11.2 has two radii.
      borderRadius: "var(--radius-card)",
    },
    /*
      No border, no shadow, no fill of its own.

      The sign-in form is not an object you act *inside* — it is the only thing
      on its half of the screen, and docs/design.md reserves a box for an object
      with an edge. It used to carry a hairline border, and because Clerk draws
      its footer *outside* the card, that border rendered as two short floating
      hairlines with nothing joining them.
    */
    card: {
      border: "none",
      borderRadius: "var(--radius-card)",
      background: "transparent",
      boxShadow: "none",
    },
    /*
      Clerk renders the footer outside the card, so its default surface fill
      reads as a second, borderless card stacked under the real one. Page
      background instead, matching the now-transparent card above it.
    */
    footer: {
      background: "var(--color-bg)",
    },
    /*
      The same button as everywhere else in the app: 32px tall, weight 500, 4px
      radius. Clerk's default is 40px at weight 600, which made the one button
      on the sign-in screen larger and heavier than any button behind it.

      (docs/design.md still says "600 only inside a primary button". That line
      is stale — components/ui/button.tsx renders every variant at 500, so 500
      is what the app's real buttons are.)
    */
    formButtonPrimary: {
      height: "44px",
      minHeight: "44px",
      fontWeight: 500,
      borderRadius: "var(--radius-control)",
      textTransform: "none",
      /*
        Clerk paints its primary button with a top-to-bottom gradient and an
        inset highlight, both as `background-image` and `box-shadow`. Setting
        `colorPrimary` only changes the colour it makes the gradient out of, so
        the button stayed glossy next to an app whose buttons are flat ink.
        These two lines are what actually flatten it.
      */
      backgroundImage: "none",
      boxShadow: "none",
    },
    /*
      The small triangle Clerk tucks inside its primary button. Nothing else in
      this app puts a glyph on a submit button, so it read as a stray mark.
    */
    buttonArrowIcon: {
      display: "none",
    },
    /*
      The "Continue with Google" button. Clerk ships it with a drop shadow;
      separation in this system comes from a 1px rule, and the only shadow
      allowed is on something that floats over the page.
    */
    socialButtonsBlockButton: {
      border: "1px solid var(--color-line)",
      borderRadius: "var(--radius-control)",
      backgroundImage: "none",
      boxShadow: "none",
    },
    // Same reason: a text field is flat and bordered here, never raised.
    formFieldInput: {
      backgroundImage: "none",
      boxShadow: "none",
    },
    // The eye toggle inside the password field. Clerk rounds small controls at
    // half the base radius (3px); §11.2 has no half-step.
    formFieldInputShowPasswordButton: {
      borderRadius: "var(--radius-control)",
    },
  },
  /*
    The avatar in the topbar, and the popover it opens.

    Component-scoped `elements` override the shared ones above, which is the
    point here: the shared `card` is now transparent and borderless, and that is
    right for a sign-in form sitting alone on a page — but this popover *floats
    over* the app, so it has to put the edge and the one allowed shadow back or
    it would appear to have no boundary at all.
  */
  userButton: {
    elements: {
      userButtonPopoverCard: {
        border: "1px solid var(--color-line)",
        borderRadius: "var(--radius-card)",
        background: "var(--color-bg)",
        boxShadow: "var(--shadow-overlay)",
      },
      userButtonPopoverActionButton: {
        borderRadius: "var(--radius-control)",
      },
      userButtonPopoverFooter: {
        background: "var(--color-bg)",
        borderTop: "1px solid var(--color-line)",
      },
    },
  },
  /*
    "Manage account" — the largest vendor surface in the app, and until now the
    only one wearing Clerk's own styling end to end.

    Same trick as the popover: it is a modal, so it floats, so the card's edge
    and shadow come back. The nav down the left is a run of rows against paper,
    separated from the content by one vertical hairline — the same rule the
    app's own sidebar follows.
  */
  userProfile: {
    elements: {
      modalContent: {
        borderRadius: "var(--radius-card)",
      },
      card: {
        border: "1px solid var(--color-line)",
        borderRadius: "var(--radius-card)",
        background: "var(--color-bg)",
        boxShadow: "var(--shadow-overlay)",
      },
      navbar: {
        background: "var(--color-bg)",
        borderRight: "1px solid var(--color-line)",
      },
      navbarButton: {
        borderRadius: "var(--radius-control)",
      },
      // Each "Email addresses", "Password", "Devices" block. A hairline above
      // it, no fill — a section is a run of rows, not a box.
      profileSection: {
        borderTop: "1px solid var(--color-line)",
      },
      profileSectionTitleText: {
        fontWeight: 500,
      },
      // Clerk's secondary actions inside the modal ("+ Add email address").
      profileSectionPrimaryButton: {
        borderRadius: "var(--radius-control)",
      },
      menuList: {
        border: "1px solid var(--color-line)",
        borderRadius: "var(--radius-card)",
        boxShadow: "var(--shadow-overlay)",
      },
    },
  },
};

/**
 * The strings Clerk says that we would rather it did not.
 *
 * **This still needs wiring into `app/layout.tsx`** — pass it as
 * `localization={clerkLocalization}` on the `ClerkProvider` beside `appearance`.
 *
 * Only one thing is blanked, and only on the first step of each flow: Clerk's
 * "Welcome back! Please sign in to continue" subtitle. The brand half of the
 * screen already carries a line of pitch two inches to the left, and two
 * greetings stacked beside each other read as a page that cannot decide which
 * one is the real one. An empty string removes the line; it does not fall back
 * to the default.
 */
export const clerkLocalization: NonNullable<
  NextClerkProviderProps["localization"]
> = {
  signIn: { start: { subtitle: "", subtitleCombined: "" } },
  signUp: { start: { subtitle: "", subtitleCombined: "" } },
};
