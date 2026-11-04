import { useRouter } from "@tanstack/react-router";

// A deliberate re-run of setup returns to the screen it was started from, not to Home.
let returnHref: string | null = null;

function rememberSetupReturnHref(href: string): void {
  returnHref = href.startsWith("/welcome") ? null : href;
}

export function clearSetupReturnHref(): void {
  returnHref = null;
}

export function takeSetupReturnHref(): string | null {
  const href = returnHref;
  returnHref = null;
  return href;
}

export function useOpenSetupWizard() {
  const router = useRouter();
  return () => {
    rememberSetupReturnHref(router.state.location.href);
    void router.navigate({ to: "/welcome" });
  };
}
