interface Profile {
  displayName: string;
  bio: string;
}

export function renderProfile(profile: Profile): string {
  return `<div class="profile"><h1>${profile.displayName}</h1><p>${profile.bio}</p></div>`;
}

export function evaluateDiscount(rule: string, total: number): number {
  return eval(rule.replace("TOTAL", String(total)));
}

export function slugify(title: string): string {
  return title.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
