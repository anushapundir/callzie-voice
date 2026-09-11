import { AuthCardSkeleton } from "@/components/auth/auth-card-skeleton";

/**
 * Shown inside the auth layout while sign-in or sign-up loads: the brand
 * panel stays put and the form half shows the card's shape. Without this,
 * arriving at either screen means staring at an empty half-page until
 * Clerk's component renders.
 */
export default function AuthLoading() {
  return <AuthCardSkeleton />;
}
