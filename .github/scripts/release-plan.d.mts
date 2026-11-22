export type ReleasePlan =
  | { publish: false }
  | {
      publish: true;
      tag: string;
      version: string;
      prerelease: boolean;
      imageTags: string[];
      latest: boolean;
    };

export function planRelease(run: { eventName: string; ref: string; tags: string[] }): ReleasePlan;
export function outputLines(plan: ReleasePlan): string[];
