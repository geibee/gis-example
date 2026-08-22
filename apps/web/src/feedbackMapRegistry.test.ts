import { describe, expect, it, vi } from "vitest";
import type { RedmineFeedbackPluginController } from "@geibee/feedback-redmine-plugin/loader";
import { connectFeedbackController, registerFeedbackMap } from "./feedbackMapRegistry";

type FeedbackMap = Parameters<RedmineFeedbackPluginController["registerMapLibreMap"]>[0];

const map = {} as FeedbackMap;

function controller(registerMapLibreMap: RedmineFeedbackPluginController["registerMapLibreMap"]): RedmineFeedbackPluginController {
  return { registerMapLibreMap } as RedmineFeedbackPluginController;
}

describe("Feedback MapLibre registry", () => {
  it("mapが先に生成されてもcontroller接続時に登録する", () => {
    const disconnectMap = vi.fn();
    const registerMapLibreMap = vi.fn(() => disconnectMap);
    const unregisterMap = registerFeedbackMap(map);
    const disconnectController = connectFeedbackController(controller(registerMapLibreMap));

    expect(registerMapLibreMap).toHaveBeenCalledWith(map);
    disconnectController();
    expect(disconnectMap).toHaveBeenCalledOnce();
    unregisterMap();
  });

  it("controllerが先に生成されてもmap登録と解除を中継する", () => {
    const disconnectMap = vi.fn();
    const registerMapLibreMap = vi.fn(() => disconnectMap);
    const disconnectController = connectFeedbackController(controller(registerMapLibreMap));
    const unregisterMap = registerFeedbackMap(map);

    expect(registerMapLibreMap).toHaveBeenCalledWith(map);
    unregisterMap();
    expect(disconnectMap).toHaveBeenCalledOnce();
    disconnectController();
  });
});
