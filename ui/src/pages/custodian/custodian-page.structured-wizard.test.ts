/* @vitest-environment jsdom */

import { GATEWAY_SERVER_CAPS } from "@openclaw/gateway-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createContext, mountPage } from "./custodian-page.test-harness.ts";

describe("custodian structured wizard", () => {
  beforeEach(() => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-4000-8000-000000000001");
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    document.body.replaceChildren();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it("keeps a rejected typed answer active without showing a submitted receipt", async () => {
    const step = {
      id: "port",
      type: "text" as const,
      message: "Gateway port",
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "validation-session",
        reply: "Enter a port.",
        action: "none",
        wizardInputPending: true,
        step,
      })
      .mockResolvedValueOnce({
        sessionId: "validation-session",
        reply: "Enter port 18789.",
        action: "none",
        wizardActionAccepted: false,
        wizardInputPending: true,
        step,
      });
    const { context } = createContext(request);
    const { page } = await mountPage(context);

    const input = await waitForFast(() => {
      const element = page.querySelector<HTMLInputElement>(
        '.custodian__wizard-step input[name="wizard-text"]',
      );
      expect(element).not.toBeNull();
      return element!;
    });
    input.value = "banana";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".custodian__wizard-step .btn.primary")!.click();

    await waitForFast(() => expect(page.textContent).toContain("Enter port 18789."));
    expect(request.mock.calls[1]?.[1]).toMatchObject({
      wizardAnswer: { stepId: "port", value: "banana" },
    });
    expect(page.querySelector(".custodian__structured-response")).toBeNull();
    expect(page.querySelector(".custodian__wizard-step")).not.toBeNull();
    expect(page.querySelector(".chat-group.user")).toBeNull();
  });

  it("does not confirm an answer after its Gateway client is replaced", async () => {
    const actionReply = createDeferred<{
      sessionId: string;
      reply: string;
      action: "none";
      wizardActionAccepted: boolean;
    }>();
    const step = {
      id: "port",
      type: "text" as const,
      message: "Gateway port",
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "rotation-session",
        reply: "Enter a port.",
        action: "none",
        wizardInputPending: true,
        step,
      })
      .mockReturnValueOnce(actionReply.promise);
    const harness = createContext(request, ["openclaw.chat"], {
      gatewayCapabilities: [
        GATEWAY_SERVER_CAPS.SYSTEM_AGENT_WIZARD_CANCEL,
        GATEWAY_SERVER_CAPS.SYSTEM_AGENT_WIZARD_ACTION_RECEIPTS,
      ],
      recoveryScope: "principal-a",
    });
    const { page } = await mountPage(harness.context);

    const input = await waitForFast(() => {
      const element = page.querySelector<HTMLInputElement>(
        '.custodian__wizard-step input[name="wizard-text"]',
      );
      expect(element).not.toBeNull();
      return element!;
    });
    input.value = "18789";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".custodian__wizard-step .btn.primary")!.click();
    await waitForFast(() => expect(page.textContent).toContain("Submitting answer"));

    harness.setGatewaySnapshot({
      client: {
        request: vi.fn().mockResolvedValue({
          sessionId: "replacement-session",
          reply: "Fresh session ready.",
          action: "none",
        }),
        recoveryScope: "principal-a",
        recoveryScopeReady: true,
      } as unknown as GatewayBrowserClient,
    });
    actionReply.resolve({
      sessionId: "rotation-session",
      reply: "Accepted by the retired client.",
      action: "none",
      wizardActionAccepted: true,
    });

    await waitForFast(() => expect(page.textContent).toContain("Gateway connection changed"));
    expect(page.textContent).not.toContain("Answer submitted");
    expect(page.querySelector(".custodian__structured-response")).toBeNull();
  });

  it("keeps older-Gateway wizard answers as plain user turns", async () => {
    const step = {
      id: "port",
      type: "text" as const,
      message: "Gateway port",
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessionId: "legacy-validation-session",
        reply: "Enter a port.",
        action: "none",
        wizardInputPending: true,
        step,
      })
      .mockResolvedValueOnce({
        sessionId: "legacy-validation-session",
        reply: "Enter port 18789.",
        action: "none",
        wizardInputPending: true,
        step,
      });
    const { context } = createContext(request, ["openclaw.chat"], {
      gatewayCapabilities: [GATEWAY_SERVER_CAPS.SYSTEM_AGENT_WIZARD_CANCEL],
    });
    const { page } = await mountPage(context);

    const input = await waitForFast(() => {
      const element = page.querySelector<HTMLInputElement>(
        '.custodian__wizard-step input[name="wizard-text"]',
      );
      expect(element).not.toBeNull();
      return element!;
    });
    input.value = "banana";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await page.updateComplete;
    page.querySelector<HTMLButtonElement>(".custodian__wizard-step .btn.primary")!.click();

    await waitForFast(() => expect(page.textContent).toContain("Enter port 18789."));
    expect(page.querySelector(".custodian__structured-response")).toBeNull();
    expect(page.querySelector(".chat-group.user")?.textContent).toContain("banana");
    expect(page.querySelector(".custodian__wizard-step")).not.toBeNull();
  });

  it("keeps server-authored guidance visible beside typed controls", async () => {
    const manifest = JSON.stringify(
      {
        display_information: {
          name: "OpenClaw",
          description: "OpenClaw connector for OpenClaw",
        },
      },
      null,
      2,
    );
    const question = "How do you want to provide this Slack bot token?";
    const request = vi.fn().mockResolvedValue({
      sessionId: "slack-wizard-session",
      reply: [
        [
          "**Slack socket mode tokens**",
          "1) Create the Slack app from the manifest below",
          "2) Enable Socket Mode",
        ].join("\n"),
        manifest,
        [
          question,
          "1. Enter Slack bot token — Stores the credential directly in OpenClaw config",
          "2. Use external secret provider — Stores a reference to an external provider",
          "Reply with a number.",
          "Say `cancel` to stop this setup.",
        ].join("\n"),
      ].join("\n\n"),
      action: "none",
      wizardInputPending: true,
      step: {
        id: "slack-token-source",
        type: "select",
        message: question,
        options: [
          {
            label: "Enter Slack bot token",
            value: "direct",
            hint: "Stores the credential directly in OpenClaw config",
          },
          {
            label: "Use external secret provider",
            value: "secret-ref",
            hint: "Stores a reference to an external provider",
          },
        ],
      },
    });
    const { context } = createContext(request);
    const { page } = await mountPage(context);

    await waitForFast(() => expect(page.querySelector(".custodian__wizard-step")).not.toBeNull());
    expect(page.querySelector(".chat-group.assistant")?.textContent).toContain(
      "Slack socket mode tokens",
    );
    expect(page.querySelector(".custodian__wizard-guidance")).toBeNull();
    expect(page.querySelectorAll('.custodian__wizard-step input[type="radio"]')).toHaveLength(2);
    expect(page.textContent).toContain("Reply with a number");
    expect(page.textContent).toContain("Say cancel");
  });
});
