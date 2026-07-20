import ProfessionalWorkbench from "@/features/workbench/ProfessionalWorkbench";
import "@/features/workbench/workbench.css";

export const metadata = {
  title: "拼豆专业工作台 · 七卡瓦",
  description: "在本地完成拼豆图纸优化、编辑、预览与制作引导。",
};

export default function WorkbenchPage() {
  return <ProfessionalWorkbench />;
}

