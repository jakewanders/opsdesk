import type { MetadataRoute } from "next";
import { getAppOrigin } from "@/lib/env/links";

/** sitemap.xml (SIT-273): only the public pages, on the configured origin. */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = getAppOrigin().origin;
  return ["/", "/privacy", "/terms"].map((path) => ({ url: `${origin}${path}` }));
}
