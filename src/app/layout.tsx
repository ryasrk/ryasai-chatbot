import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Toaster as SonnerToaster } from "@/components/ui/sonner";
import { THEME_INIT_SCRIPT } from "@/lib/themes";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
});

const jetbrains = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ryasai",
  description:
    "ryasai — enterprise AI platform for knowledge, query engine, dynamic database integration, RAG, and security guardrails.",
  keywords: [
    "ryasai",
    "Enterprise AI",
    "Text-to-SQL",
    "RAG",
    "Knowledge Base",
    "Dynamic Connector",
  ],
  authors: [{ name: "ryasai" }],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body
        className={`${inter.variable} ${jetbrains.variable} antialiased bg-background text-foreground`}
        suppressHydrationWarning
      >
        {children}
        <SonnerToaster position="top-right" richColors closeButton />
      </body>
    </html>
  );
}
