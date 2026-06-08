import type { ReactNode } from "react";
import { Logo } from "@/components/logo";
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

export function ScreenState({
  title,
  description,
  actions,
  isLoading = false,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  isLoading?: boolean;
}) {
  return (
    <div className="flex min-h-dvh w-full flex-1 items-center justify-center px-6">
      <Card className="w-full max-w-md p-8 text-center shadow-sm">
        <div className="mx-auto mb-5 flex justify-center">
          <Logo size={56} hero={isLoading} />
        </div>
        <CardHeader className="items-center p-0 text-center">
          <CardTitle className="text-xl">{title}</CardTitle>
          {description ? (
            <CardDescription className="max-w-sm text-center leading-relaxed">{description}</CardDescription>
          ) : null}
        </CardHeader>
        {actions ? <CardFooter className="mt-5 justify-center gap-3 p-0">{actions}</CardFooter> : null}
      </Card>
    </div>
  );
}
