import { html } from "lit";
// Keep the font's arcade styling, with an open-top 4 that remains readable at card size.
export function pixelRating(rating: number) {
  return [...rating.toLocaleString()].map((digit) =>
    digit === "4"
      ? html`<span class="sp-elo-four"
          >4<svg aria-hidden="true" viewBox="0 0 6 6" preserveAspectRatio="none" focusable="false">
            <path
              fill="currentColor"
              d="M0 0h1v3h2V0h2v3h1v1H5v2H3V4H0z"
            /></svg
        ></span>`
      : digit,
  );
}

