import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const githubPagesPath = process.env.GITHUB_PAGES === "1" ? "/PIN-Design" : "";
const publicAsset = (fileName: string) => `${githubPagesPath}/${fileName}`;

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "七卡瓦拼豆专业工作台",
  applicationName: "拼豆工作台",
  description: "在设备本地完成拼豆图纸优化、编辑、预览与制作引导，支持离线安装。",
  manifest: publicAsset("manifest.webmanifest"),
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "拼豆工作台",
  },
  icons: {
    icon: [
      { url: publicAsset("icon-192x192.png"), sizes: "192x192", type: "image/png" },
      { url: publicAsset("icon-512x512.png"), sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: publicAsset("icon-192x192.png"), sizes: "192x192", type: "image/png" }],
  },
};

export const viewport: Viewport = {
  themeColor: "#d37d5d",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased overflow-x-hidden bg-gray-50 text-gray-900`}>
        {children}
      </body>
    </html>
  );
}
