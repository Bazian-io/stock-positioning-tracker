"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// The site's main sections. A section stays highlighted on its own pages, e.g. Investors on an
// investor dashboard. New sections are added here.
const SECTIONS = [
  { href: "/", label: "Home" },
  { href: "/investors", label: "Investors" },
  { href: "/stocks", label: "Stocks" },
];

export function SiteNav() {
  const pathname = usePathname();
  return (
    <nav className="site-nav" aria-label="Main">
      {SECTIONS.map(({ href, label }) => {
        const inSection = href !== "/" && pathname.startsWith(`${href}/`);
        return (
          <Link key={href} href={href} aria-current={pathname === href ? "page" : inSection ? "true" : undefined}>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
