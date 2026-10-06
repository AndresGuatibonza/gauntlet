/**
 * How a "Build this" brief's state is sent to the browser, shared by the
 * per-card route (cards/[index]/package) and the report-wide one
 * (packages), so both answer in exactly the same shape.
 */
import { renderActionPackageMarkdown, renderCodingAgentPrompt, type ActionPackage } from "@gauntlet/core";
import type { ActionPackageState } from "@/lib/store";

export type PackageStateBody =
  | { status: "ready"; package: ActionPackage; codingAgentPrompt: string; markdown: string }
  | { status: "generating" }
  | { status: "failed"; error: string; canRetry: boolean }
  | { status: "none" };

export function packageStateBody(state: ActionPackageState): PackageStateBody {
  switch (state.state) {
    case "ready":
      return {
        status: "ready",
        package: state.package,
        codingAgentPrompt: renderCodingAgentPrompt(state.package),
        markdown: renderActionPackageMarkdown(state.package),
      };
    case "generating":
      return { status: "generating" };
    case "failed":
      return { status: "failed", error: state.errorMessage, canRetry: state.canRetry };
    case "none":
      return { status: "none" };
  }
}
