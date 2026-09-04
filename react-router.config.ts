import type { Config } from "@react-router/dev/config";
import { vercelPreset } from "@vercel/react-router/vite";

/**
 * The Vercel preset is applied only when deploying to Vercel. Locally and in
 * CI, `shopify app dev` and `react-router build` run against the default Node
 * target, so development is not coupled to the hosting provider.
 */
const onVercel = Boolean(process.env.VERCEL);

export default {
  ssr: true,
  ...(onVercel ? { presets: [vercelPreset()] } : {}),
} satisfies Config;
