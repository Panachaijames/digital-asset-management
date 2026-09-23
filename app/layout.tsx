import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

// One face, two weights. The dwp.intelligence standard allows 400 and 500
// only, so 600 and 700 are no longer loaded at all. (Proxima Nova is the
// brand face and leads the stack in tailwind.config.ts; Inter is what is
// licensed and self-hosted here — gap 2 in the review is still open.)
const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  weight: ["400", "500"],
  display: "swap",
});

// One name for the app, everywhere it appears: "Digital Assets".
export const metadata: Metadata = {
  title: "Digital Assets — dwp.intelligence",
  description: "Drive-backed digital asset manager with Supabase tagging and AI search across all dwp. studios.",
};

import { AutoTagProvider } from "@/components/AutoTagContext";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // suppressHydrationWarning: the inline script below may add a theme class
    // to <html> before React hydrates, which is expected.
    <html lang="en" suppressHydrationWarning className={inter.variable}>
      <head>
        {/* Apply the saved appearance before first paint so there's no flash.
            light -> :root, dark -> .dark, system -> .claude (the warm cream
            palette, a recorded exception to the standard). Kept in step with
            applyMode() in components/ThemeToggle.tsx. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var m=localStorage.getItem("dam-theme")||"light";var c=document.documentElement.classList;c.toggle("dark",m==="dark");c.toggle("claude",m==="system");}catch(e){}})();`,
          }}
        />
      </head>
      <body className="font-sans antialiased">
        <AutoTagProvider>{children}</AutoTagProvider>
      </body>
    </html>
  );
}
