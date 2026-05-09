import { Toaster as SonnerToaster, type ToasterProps } from "sonner";
import { useTheme } from "@/providers/theme-provider";

export function Toaster(props: ToasterProps) {
  const { theme } = useTheme();
  const resolved: ToasterProps["theme"] = theme === "system" ? "system" : theme;
  return (
    <SonnerToaster
      theme={resolved}
      position="bottom-right"
      richColors
      closeButton
      toastOptions={{
        classNames: {
          toast: "group toast bg-card text-foreground border border-border shadow-lg",
          description: "text-muted-foreground",
        },
      }}
      {...props}
    />
  );
}
