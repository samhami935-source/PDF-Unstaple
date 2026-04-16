import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PDF Unstapler",
  description: "Split a PDF into one file per page and export as ZIP.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
