import type { Metadata } from "next";
import { Fraunces, Montserrat, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-fraunces",
  weight: ["400", "500", "600"],
  style: ["normal", "italic"],
});

const montserrat = Montserrat({
  subsets: ["latin"],
  variable: "--font-montserrat",
  weight: ["400", "500", "600", "700"],
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "dwp.dam — Asset Manager",
  description: "Drive-backed digital asset manager with Supabase tagging and search.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // suppressHydrationWarning: the inline script below may add .dark to
    // <html> before React hydrates, which is expected.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Apply the saved theme before first paint so there's no flash.
            Modes: light | dark (default) | system (= Claude cream/coral
            palette, the .claude class) — see ThemeToggle.tsx. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var m=localStorage.getItem("dam-theme")||"dark";var c=document.documentElement.classList;c.toggle("dark",m==="dark");c.toggle("claude",m==="system");}catch(e){}})();`,
          }}
        />
      </head>
      <body
        className={`${fraunces.variable} ${montserrat.variable} ${jetbrainsMono.variable}`}
      >
        {children}
      </body>
    </html>
  );
}
