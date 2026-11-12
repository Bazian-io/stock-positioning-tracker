import NextLink from "next/link";
import type { ComponentProps } from "react";

// Next.js normally preloads every link that scrolls into view. Each preload runs a server function
// and, for stock and investor pages, database lookups: about 30 hidden requests per page view.
// Use this Link for all in-app links, so a page loads only when a visitor clicks it.
export function Link(props: ComponentProps<typeof NextLink>) {
  return <NextLink {...props} prefetch={false} />;
}
