import type {
  FeedbackApplicationManifestV1,
  FeedbackLocationV1
} from "@feedback/contracts";

type ManifestRoute = FeedbackApplicationManifestV1["routes"][number];

const applicationKeyPattern = /^[a-z][a-z0-9-]{0,62}$/;
const pageKeyPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const parameterSegmentPattern = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** manifest を型付けし、server と同じ重複・route parameter 境界を起動時に検査する。 */
export function defineFeedbackManifest<const T extends FeedbackApplicationManifestV1>(manifest: T): T {
  if (manifest.schemaVersion !== "1") throw new Error(`未対応のmanifest schema: ${manifest.schemaVersion}`);
  if (!applicationKeyPattern.test(manifest.applicationKey)) {
    throw new Error(`applicationKeyが不正です: ${manifest.applicationKey}`);
  }
  if (!manifest.displayName.trim() || !manifest.manifestVersion.trim()) {
    throw new Error("displayNameとmanifestVersionは必須です");
  }
  if (manifest.routes.length === 0) throw new Error("manifestには1件以上のrouteが必要です");

  const pageKeys = new Set<string>();
  const templates = new Set<string>();
  for (const route of manifest.routes) {
    validateRoute(route);
    if (pageKeys.has(route.pageKey)) throw new Error(`pageKeyが重複しています: ${route.pageKey}`);
    if (templates.has(route.template)) throw new Error(`templateが重複しています: ${route.template}`);
    pageKeys.add(route.pageKey);
    templates.add(route.template);
  }
  return manifest;
}

/** pathname を manifest の location へ変換する。query は明示されたキーだけを候補として返す。 */
export function resolveFeedbackLocation(
  manifest: FeedbackApplicationManifestV1,
  pathname: string,
  search = ""
): FeedbackLocationV1 | null {
  const normalizedPath = normalizePath(pathname);
  const candidates = [...manifest.routes]
    .flatMap((route) => [route, ...(route.aliases ?? []).map((template) => ({ ...route, template }))])
    .sort((left, right) => parameterCount(left.template) - parameterCount(right.template));
  for (const route of candidates) {
    const pathParameters = matchTemplate(route.template, normalizedPath);
    if (!pathParameters) continue;
    return {
      schemaVersion: "1",
      pageKey: route.pageKey,
      routeTemplate: route.template,
      pathParameters,
      ...(route.queryParameters
        ? { queryParameters: pickQueryParameters(search, route.queryParameters) }
        : {})
    };
  }
  return null;
}

/** browser 以外の host adapter でも利用できる location/manifest 整合性検査。 */
export function validateFeedbackLocation(
  manifest: FeedbackApplicationManifestV1,
  location: FeedbackLocationV1
): void {
  if (location.schemaVersion !== "1") throw new Error(`未対応のlocation schema: ${location.schemaVersion}`);
  const route = manifest.routes.find(
    (candidate) => candidate.pageKey === location.pageKey &&
      (candidate.template === location.routeTemplate || candidate.aliases?.includes(location.routeTemplate))
  );
  if (!route) throw new Error("locationがapplication manifestに登録されていません");
  const names = parameterNames(location.routeTemplate);
  if (names.length !== Object.keys(location.pathParameters).length || names.some((name) => !(name in location.pathParameters))) {
    throw new Error("locationのpathParametersがroute templateと一致しません");
  }
  const allowedQuery = new Set(Object.entries(route.queryParameters ?? {})
    .filter(([, policy]) => policy.persistence !== "discard")
    .map(([name]) => name));
  if (Object.keys(location.queryParameters ?? {}).some((name) => !allowedQuery.has(name))) {
    throw new Error("locationにmanifest未登録のquery parameterが含まれています");
  }
}

function validateRoute(route: ManifestRoute): void {
  if (!pageKeyPattern.test(route.pageKey)) throw new Error(`pageKeyが不正です: ${route.pageKey}`);
  if (!route.label.trim()) throw new Error(`route labelが空です: ${route.pageKey}`);
  validateTemplate(route.template);
  for (const alias of route.aliases ?? []) validateTemplate(alias);

  const names = new Set(parameterNames(route.template));
  const policies = Object.keys(route.parameters ?? {});
  if (policies.some((name) => !names.has(name)) || [...names].some((name) => !policies.includes(name))) {
    throw new Error(`route parameter policyがtemplateと一致しません: ${route.template}`);
  }
}

function validateTemplate(template: string): void {
  if (!template.startsWith("/") || template.includes("?") || template.includes("#")) {
    throw new Error(`route templateはquery/hashを含まない絶対pathで指定してください: ${template}`);
  }
  const invalid = segments(template).find(
    (segment) => (segment.includes("{") || segment.includes("}")) && !parameterSegmentPattern.test(segment)
  );
  if (invalid) throw new Error(`route parameterはsegment全体を{name}形式で指定してください: ${template}`);
}

function matchTemplate(template: string, pathname: string): Record<string, string> | null {
  const templateSegments = segments(normalizePath(template));
  const pathSegments = segments(pathname);
  if (templateSegments.length !== pathSegments.length) return null;
  const result: Record<string, string> = {};
  for (let index = 0; index < templateSegments.length; index += 1) {
    const parameter = parameterSegmentPattern.exec(templateSegments[index]);
    if (parameter) {
      if (!pathSegments[index]) return null;
      result[parameter[1]] = decode(pathSegments[index]);
    } else if (templateSegments[index] !== pathSegments[index]) {
      return null;
    }
  }
  return result;
}

function pickQueryParameters(
  search: string,
  policies: NonNullable<ManifestRoute["queryParameters"]>
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of search.replace(/^\?/, "").split("&")) {
    if (!pair) continue;
    const separator = pair.indexOf("=");
    const name = decode(separator >= 0 ? pair.slice(0, separator) : pair);
    const policy = policies[name];
    if (!policy || policy.persistence === "discard" || name in result) continue;
    result[name] = decode(separator >= 0 ? pair.slice(separator + 1) : "");
  }
  return result;
}

function parameterNames(template: string): string[] {
  return segments(template).flatMap((segment) => parameterSegmentPattern.exec(segment)?.[1] ?? []);
}

function parameterCount(template: string): number {
  return parameterNames(template).length;
}

function normalizePath(value: string): string {
  const path = value.split(/[?#]/, 1)[0] || "/";
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function segments(path: string): string[] {
  return path === "/" ? [] : path.replace(/^\//, "").split("/");
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}
