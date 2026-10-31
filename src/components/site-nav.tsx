"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import { reportingQuarter, researchHref } from "@/lib/research";

// The site's main sections. A section stays highlighted on its own pages, e.g. Investors on an
// investor dashboard. New sections are added here.
const SECTIONS = [
  { href: "/", label: "Home" },
  { href: "/search", label: "Search" },
  { href: "/investors", label: "Investors" },
  { href: "/stocks", label: "Stocks" },
  { href: "/compare", label: "Compare" },
];

function NavigationLinks({ pathname = "", quarter }: { pathname?: string; quarter?: string }) {
  return (
    <nav className="site-nav" aria-label="Main">
      {SECTIONS.map(({ href, label }) => {
        const inSection = href !== "/" && pathname.startsWith(`${href}/`);
        return (
          <Link key={href} href={researchHref(href, { quarter })} aria-current={pathname === href ? "page" : inSection ? "true" : undefined}>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

export function SiteNav() {
  const pathname = usePathname();
  const quarter = reportingQuarter(useSearchParams().get("quarter"));
  return <NavigationLinks pathname={pathname} quarter={quarter} />;
}

export function SiteNavFallback() {
  return <NavigationLinks />;
}

export function QuarterHomeLink({ children }: { children: ReactNode }) {
  const quarter = reportingQuarter(useSearchParams().get("quarter"));
  return <Link href={researchHref("/", { quarter })} className="brand">{children}</Link>;
}
