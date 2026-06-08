import { useSidebar, useSidebarLayout } from "@/components/ui/sidebar";

export function useShouldShowChatModeControls(): boolean {
  const { open } = useSidebar("left");
  const { isSheetMode } = useSidebarLayout();
  return isSheetMode || !open;
}
