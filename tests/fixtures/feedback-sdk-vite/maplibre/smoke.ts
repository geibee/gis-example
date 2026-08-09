import { bindMapLibreFeedbackPins, resolveMapLibreFeedbackTarget } from "@feedback/maplibre";

type Binding = ReturnType<typeof bindMapLibreFeedbackPins>;
type Target = ReturnType<typeof resolveMapLibreFeedbackTarget>;

export type MapLibrePackageSmoke = { binding: Binding; target: Target };
