declare module "*.css";

/**
 * App Bridge custom elements.
 *
 * `s-app-nav` is provided by App Bridge at runtime rather than by
 * @shopify/polaris-types, so it needs an explicit JSX declaration.
 */
declare namespace JSX {
  interface IntrinsicElements {
    "s-app-nav": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
  }
}
