import { useAuth } from "@workos-inc/authkit-react";
import { Link, useLocation } from "react-router-dom";
import { ChatCircleText, Moon, Sun, SignOut, UserCircle, Gear } from "@phosphor-icons/react";
import { useTheme } from "@/providers/theme-provider";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DEFAULT_AUTHENTICATED_PATH, SETTINGS_PATH, settingsPath } from "@/route-paths";

/**
 * Compact profile avatar with dropdown menu. Shows only the avatar circle —
 * no name or email. Designed to sit alongside the repository selector in a
 * single footer row.
 */
export function ProfileCard() {
  const { user, signIn, signOut } = useAuth();
  const { theme, setTheme } = useTheme();
  const location = useLocation();
  const isDark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);

  if (!user) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => void signIn()}
        className="size-8 shrink-0 p-0"
        aria-label="Sign in"
      >
        <Avatar className="h-8 w-8 shrink-0 rounded-md">
          <AvatarFallback className="rounded-md bg-muted">
            <UserCircle size={18} weight="bold" className="text-muted-foreground" />
          </AvatarFallback>
        </Avatar>
      </Button>
    );
  }

  const displayName = user.firstName
    ? `${user.firstName}${user.lastName ? ` ${user.lastName}` : ""}`
    : (user.email ?? "User");

  const avatarUrl = user.profilePictureUrl;
  const currentPath = `${location.pathname}${location.search}${location.hash}`;
  const settingsFrom = location.pathname.startsWith(SETTINGS_PATH) ? DEFAULT_AUTHENTICATED_PATH : currentPath;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 p-0" aria-label={displayName}>
          <Avatar className="h-8 w-8 shrink-0 rounded-md">
            <AvatarImage src={avatarUrl ?? undefined} alt={displayName} className="rounded-md" />
            <AvatarFallback className="rounded-md bg-muted text-xs font-semibold uppercase">
              {displayName.charAt(0)}
            </AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent side="top" align="start" className="w-56">
        {/* User info header */}
        <div className="px-2 py-1.5">
          <p className="truncate text-sm font-semibold">{displayName}</p>
          {user.email && <p className="truncate text-xs text-muted-foreground">{user.email}</p>}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to={settingsPath("customization", settingsFrom)}>
            <Gear weight="bold" />
            <span>Settings</span>
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem disabled title="Coming soon">
          <ChatCircleText weight="bold" />
          <span>Feedback</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => setTheme(isDark ? "light" : "dark")}>
          {isDark ? <Sun weight="bold" /> : <Moon weight="bold" />}
          <span>{isDark ? "Light mode" : "Dark mode"}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => signOut()} className="text-destructive focus:text-destructive">
          <SignOut weight="bold" />
          <span>Sign out</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
