import { Suspense } from "react";
import LoginForm from "./LoginForm";

// Server component on purpose. LoginForm calls useSearchParams(), which in
// Next 15 throws a BUILD error unless a <Suspense> boundary sits ABOVE the call
// — and "above" means in a different component, so wrapping it inside LoginForm
// would not help. That build failure happens inside the Docker builder stage,
// so it would abort the deploy with an error message about Suspense rather than
// about sign-in.
//
// Stays directly under the root layout: a route-group layout that re-declares
// <html>/<body> would drop the pre-paint theme script and render /login with no
// theme class at all.

export const metadata = {
  title: "Sign in — dwp.dam",
};

export default function LoginPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-6 py-12 font-sans text-body">
      <Suspense fallback={null}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
