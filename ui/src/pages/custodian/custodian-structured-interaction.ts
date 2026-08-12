import type { SystemAgentChatParams } from "@openclaw/gateway-protocol";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { t } from "../../i18n/index.ts";
import { custodianWizardSubmission } from "./custodian-wizard-step.ts";
import type * as eventNudgeState from "./event-nudge.ts";
import type { CustodianMessage, CustodianStructuredResponse } from "./transcript.ts";

type StructuredInteractionState = {
  activeClient: GatewayBrowserClient | null;
  chatAvailable: boolean;
  messages: readonly CustodianMessage[];
  sending: boolean;
  sessionId: string;
  setupRequired: boolean;
  wizardCancelAvailable: boolean;
  wizardActionReceiptsAvailable: boolean;
  wizardInputPending: boolean;
};

type StructuredInteractionHost = {
  state: () => StructuredInteractionState;
  emit: () => void;
  replaceMessages: (messages: CustodianMessage[]) => void;
  sendUserTurn: (
    client: GatewayBrowserClient,
    params: SystemAgentChatParams,
    display: string,
    appendUserMessage: boolean,
  ) => Promise<eventNudgeState.CustodianSendOutcome>;
};

function withResponse(
  messages: readonly CustodianMessage[],
  messageId: number,
  response: CustodianStructuredResponse | null,
): CustodianMessage[] | null {
  const target = messages.find((message) => message.id === messageId);
  return target
    ? messages.map((message) =>
        message === target ? { ...message, structuredResponse: response } : message,
      )
    : null;
}

export function createCustodianStructuredInteraction(host: StructuredInteractionHost) {
  const submit = async (params: {
    client: GatewayBrowserClient;
    message: CustodianMessage;
    request: SystemAgentChatParams;
    display: string;
    kind: CustodianStructuredResponse["kind"];
    prompt?: string;
  }): Promise<eventNudgeState.CustodianSendOutcome> => {
    const state = host.state();
    if (
      !state.chatAvailable ||
      state.sending ||
      state.setupRequired ||
      !state.messages.includes(params.message)
    ) {
      host.emit();
      return "rejected";
    }
    if (state.wizardActionReceiptsAvailable) {
      host.replaceMessages(
        withResponse(state.messages, params.message.id, {
          display: params.display,
          kind: params.kind,
          state: "submitting",
          ...(params.prompt ? { prompt: params.prompt } : {}),
        }) ?? [...state.messages],
      );
      host.emit();
    }
    const outcome = await host.sendUserTurn(
      params.client,
      params.request,
      params.display,
      !state.wizardActionReceiptsAvailable,
    );
    if (!state.wizardActionReceiptsAvailable) {
      return outcome;
    }
    const current = host.state();
    const response: CustodianStructuredResponse | null =
      outcome !== "accepted"
        ? null
        : {
            display: params.display,
            kind: params.kind,
            state: "submitted",
            ...(params.prompt ? { prompt: params.prompt } : {}),
          };
    const messages = withResponse(current.messages, params.message.id, response);
    if (messages) {
      host.replaceMessages(messages);
      host.emit();
    }
    return outcome;
  };

  return {
    answerWizardStep(message: CustodianMessage, value: unknown): void {
      const state = host.state();
      const submission = message.step ? custodianWizardSubmission(message.step, value) : null;
      if (!submission || !state.activeClient || !state.wizardInputPending) {
        host.emit();
        return;
      }
      void submit({
        client: state.activeClient,
        message,
        request: { sessionId: state.sessionId, wizardAnswer: submission.answer },
        display: message.step?.sensitive ? t("custodian.sensitiveReply") : submission.display,
        kind: "answer",
        prompt: message.step?.title ?? message.step?.message,
      });
    },

    cancelWizardStep(message: CustodianMessage): void {
      const state = host.state();
      const step = message.step;
      const activeWizardMessage = state.messages.findLast((candidate) => candidate.step !== null);
      if (
        !step ||
        message !== activeWizardMessage ||
        !state.wizardInputPending ||
        !state.wizardCancelAvailable ||
        !state.activeClient
      ) {
        host.emit();
        return;
      }
      void submit({
        client: state.activeClient,
        message,
        request: { sessionId: state.sessionId, wizardCancel: { stepId: step.id } },
        display: t("custodian.cancel"),
        kind: "cancel",
        prompt: step.title ?? step.message,
      });
    },
  };
}
