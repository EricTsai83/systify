import { Logo } from "@/components/logo";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

export function ScreenState({
  title,
  description,
  isLoading = false,
}: {
  title: string;
  description?: string;
  isLoading?: boolean;
}) {
  return (
    <div className="flex min-h-full w-full flex-1 items-center justify-center px-6">
      <Card className="w-full max-w-md p-8 text-center shadow-sm">
        <div className="mx-auto mb-5 flex justify-center">
          <Logo size={56} hero={isLoading} />
        </div>
        <CardHeader className="p-0">
          <CardTitle className="text-xl">{title}</CardTitle>
          {description ? <CardDescription className="leading-relaxed">{description}</CardDescription> : null}
        </CardHeader>
      </Card>
    </div>
  );
}
