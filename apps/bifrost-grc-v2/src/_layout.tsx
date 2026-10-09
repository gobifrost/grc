import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { cn } from "@/lib/utils";
import {
  AlertOctagon,
  AlertTriangle,
  BookOpen,
  ClipboardCheck,
  ClipboardList,
  FileText,
  LayoutDashboard,
  ListChecks,
  ListTodo,
  Menu,
  Paperclip,
  Settings,
  Shield,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import ConfirmDialogHost from "./components/shared/ConfirmDialog";
import OrganizationViewBar from "./components/shared/OrganizationViewBar";
import { useOpenItemsSummary } from "./lib/open-items";
import { useOrganizationView } from "./lib/organization-view";
import "./styles.css";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  // route prefix match (e.g. /frameworks/abc still highlights Frameworks)
  prefix?: boolean;
}

interface NavGroup {
  label: string;
  items: NavItem[];
  administrative?: boolean;
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { to: "/", label: "Dashboard", icon: LayoutDashboard },
      { to: "/open-items", label: "Open Items", icon: ListTodo, prefix: true },
    ],
  },
  {
    label: "Standards",
    items: [
      { to: "/frameworks", label: "Frameworks", icon: BookOpen, prefix: true },
      { to: "/controls", label: "Controls", icon: Shield, prefix: true },
    ],
  },
  {
    label: "Program",
    items: [
      { to: "/assessments", label: "Assessments", icon: ClipboardCheck, prefix: true },
      { to: "/applied-controls", label: "Applied Controls", icon: ListChecks, prefix: true },
      { to: "/evidence", label: "Evidence", icon: Paperclip, prefix: true },
    ],
  },
  {
    label: "Governance",
    items: [
      { to: "/policies", label: "Policies", icon: FileText, prefix: true },
      { to: "/risks", label: "Risks", icon: AlertTriangle, prefix: true },
      { to: "/exceptions", label: "Exceptions", icon: AlertOctagon, prefix: true },
    ],
  },
  {
    label: "Reviews",
    items: [
      { to: "/questionnaires", label: "Questionnaires", icon: ClipboardList, prefix: true },
    ],
  },
  {
    label: "Administration",
    administrative: true,
    items: [{ to: "/settings", label: "Settings", icon: Settings, prefix: true }],
  },
];

const NAV_ITEMS = NAV_GROUPS.flatMap((group) => group.items);

function isItemActive(item: NavItem, pathname: string) {
  if (item.to === "/") return pathname === "/";
  if (item.prefix) return pathname === item.to || pathname.startsWith(item.to + "/");
  return pathname === item.to;
}

export default function RootLayout() {
  const location = useLocation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [routePending, setRoutePending] = useState(false);
  const routePendingAt = useRef(0);
  const committedLocationKey = useRef(location.key);
  const { openCount: openItemsCount, loading: openItemsLoading } = useOpenItemsSummary();
  const { organizationId } = useOrganizationView();
  const openItemsCountLabel = organizationId ? "open" : "ready for review";
  const activeItem = NAV_ITEMS.find((item) => isItemActive(item, location.pathname));

  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (committedLocationKey.current === location.key) return;
    committedLocationKey.current = location.key;
    const elapsed = performance.now() - routePendingAt.current;
    const timer = window.setTimeout(() => setRoutePending(false), Math.max(0, 180 - elapsed));
    return () => window.clearTimeout(timer);
  }, [location.key]);

  function announceInternalNavigation(event: ReactMouseEvent<HTMLDivElement>) {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[href]");
    if (!anchor || anchor.target || anchor.hasAttribute("download")) return;
    const destination = new URL(anchor.href, window.location.href);
    const current = new URL(window.location.href);
    if (destination.origin !== current.origin || (destination.pathname === current.pathname && destination.search === current.search)) return;
    routePendingAt.current = performance.now();
    setRoutePending(true);
  }

  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileNavOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileNavOpen]);

  return (
    <div className="relative flex h-full overflow-hidden bg-[var(--bf-canvas)] font-[var(--bf-font-sans)] text-[var(--bf-ink)]" data-density="compact" onClickCapture={announceInternalNavigation}>
      {mobileNavOpen && (
        <button
          className="absolute inset-0 z-40 border-0 bg-[rgba(7,51,65,.58)] min-[900px]:hidden motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-[var(--bf-motion-disclosure)]"
          type="button"
          aria-label="Close navigation"
          onClick={() => setMobileNavOpen(false)}
        />
      )}

      <aside
        id="grc-primary-navigation"
        className={cn(
          "cv-bds-rail absolute inset-y-0 left-0 z-50 flex w-[min(84vw,280px)] -translate-x-full shrink-0 flex-col overflow-hidden border-r border-[var(--bf-line)] bg-[var(--bf-paper)] text-[var(--bf-ink)] shadow-[var(--bf-shadow-float)] transition-transform min-[900px]:relative min-[900px]:z-auto min-[900px]:w-61 min-[900px]:translate-x-0 min-[900px]:shadow-none",
          mobileNavOpen && "translate-x-0",
        )}
      >
        <div className="flex min-h-12 items-center justify-between border-b border-[var(--bf-line)] px-3 pl-4 text-sm font-medium min-[900px]:hidden">
          <span>GRC navigation</span>
          <button
            type="button"
            className="inline-flex size-8 items-center justify-center rounded-[var(--bf-radius-control)] text-[var(--bf-muted)] outline-none hover:bg-[var(--bf-cool)] hover:text-[var(--bf-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--bf-primary)]"
            aria-label="Close navigation"
            onClick={() => setMobileNavOpen(false)}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <nav className="flex min-h-0 flex-1 flex-col overflow-y-auto py-2" aria-label="GRC navigation">
          {NAV_GROUPS.map((group) => (
            <div
              key={group.label}
              className={cn(
                "px-3 py-1.5",
                group.administrative && "mt-auto pt-4",
              )}
            >
              <div className="px-2 pb-1.5 text-[10px] font-medium uppercase tracking-[0.14em] text-[var(--bf-muted)]">{group.label}</div>
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = isItemActive(item, location.pathname);
                const itemCount = item.to === "/open-items" && !openItemsLoading ? openItemsCount : 0;
                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    end={item.to === "/"}
                    aria-label={itemCount ? `${item.label}, ${itemCount} ${openItemsCountLabel}` : item.label}
                    title={item.label}
                    className={cn(
                      "group flex min-h-11 items-center justify-start gap-[11px] border-l-2 border-l-transparent px-2.5 text-[13px] text-[var(--bf-muted)] outline-none transition-[color,border-color] duration-[var(--bf-motion-feedback)] ease-[var(--bf-ease-standard)] hover:text-[var(--bf-ink)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--bf-primary)]",
                      active && "border-l-[var(--bf-primary)] font-semibold text-[var(--bf-primary)]",
                    )}
                  >
                    <span className="inline-flex size-4 shrink-0" aria-hidden="true">
                      <Icon size={17} />
                    </span>
                    <span className="min-w-0 truncate transition-transform duration-[var(--bf-motion-disclosure)] ease-[var(--bf-ease-out)] group-hover:translate-x-[3px]">{item.label}</span>
                    {itemCount > 0 ? (
                      <span
                        className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-[var(--bf-primary)] px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white"
                        aria-hidden="true"
                        title={`${itemCount} ${openItemsCountLabel}`}
                      >
                        {itemCount > 99 ? "99+" : itemCount}
                      </span>
                    ) : null}
                  </NavLink>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>

      <div className="relative flex-1 min-w-0 min-h-0 flex flex-col">
        <div className={`cv-route-progress ${routePending ? "is-active" : ""}`} role="status" aria-live="polite" aria-label={routePending ? "Opening page" : undefined}><span /></div>
        <div className="flex min-h-12 items-center gap-2 border-b border-[var(--bf-line)] bg-[var(--bf-paper)] px-3 min-[900px]:hidden">
          <button
            type="button"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-[var(--bf-radius-control)] text-[var(--bf-muted)] outline-none hover:bg-[var(--bf-cool)] hover:text-[var(--bf-primary)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--bf-primary)]"
            aria-label="Open navigation"
            aria-controls="grc-primary-navigation"
            aria-expanded={mobileNavOpen}
            onClick={() => setMobileNavOpen(true)}
          >
            <Menu size={20} aria-hidden="true" />
          </button>
          <span className="min-w-0 truncate text-sm font-medium">{activeItem?.label ?? "GRC"}</span>
          {activeItem?.to === "/open-items" && !openItemsLoading && openItemsCount > 0 ? (
            <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-[var(--bf-primary)] px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white" aria-label={`${openItemsCount} ${openItemsCountLabel}`}>
              {openItemsCount > 99 ? "99+" : openItemsCount}
            </span>
          ) : null}
        </div>

        <OrganizationViewBar />

        <main className={`min-h-0 flex-1 overflow-auto px-4 py-5 sm:px-6 md:px-8 md:py-7 ${routePending ? "is-route-pending" : ""}`}>
          <div key={location.pathname} className="cv-route-content">
            <Outlet />
          </div>
        </main>

        <ConfirmDialogHost />
      </div>
    </div>
  );
}
