import {
    type AuthStatus,
    type AutocompleteContextSnippet,
    type ClientConfiguration,
    type ClientConfigurationWithAccessToken,
    type CodeCompletionsClient,
    type CodeCompletionsParams,
    type CompletionResponseGenerator,
    dotcomTokenToGatewayToken,
    tokensToChars,
} from '@sourcegraph/cody-shared'
import { forkSignal, generatorWithTimeout, zipGenerators } from '../utils'

import { createFastPathClient } from '../fast-path-client'
import { TriggerKind } from '../get-inline-completions'
import { type DefaultModel, getModelHelpers } from '../model-helpers'
import {
    type FetchCompletionResult,
    fetchAndProcessDynamicMultilineCompletions,
} from './fetch-and-process-completions'
import {
    MAX_RESPONSE_TOKENS,
    getCompletionParams,
    getLineNumberDependentCompletionParams,
} from './get-completion-params'
import {
    type CompletionProviderTracer,
    Provider,
    type ProviderConfig,
    type ProviderOptions,
    standardContextSizeHints,
} from './provider'

export interface FireworksOptions {
    model: FireworksModel
    maxContextTokens?: number
    client: CodeCompletionsClient
    anonymousUserID?: string
    config: Pick<
        ClientConfigurationWithAccessToken,
        'accessToken' | 'autocompleteExperimentalFireworksOptions'
    >
    authStatus: Pick<
        AuthStatus,
        'userCanUpgrade' | 'isDotCom' | 'endpoint' | 'isFireworksTracingEnabled'
    >
}

const PROVIDER_IDENTIFIER = 'fireworks'

export const FIREWORKS_DEEPSEEK_7B_LANG_SPECIFIC_V0 = 'deepseek-finetuned-lang-specific-v0'
export const FIREWORKS_DEEPSEEK_7B_LANG_SPECIFIC_V1 = 'deepseek-finetuned-lang-specific-v1'
export const FIREWORKS_DEEPSEEK_7B_LANG_ALL = 'deepseek-finetuned-lang-all-v0'

export const DEEPSEEK_CODER_V2_LITE_BASE_DIRECT_ROUTE = 'deepseek-coder-v2-lite-base-direct-route'
export const DEEPSEEK_CODER_V2_LITE_BASE = 'deepseek-coder-v2-lite-base'

// Context window experiments with DeepSeek Model
export const DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_4096 = 'deepseek-coder-v2-lite-base-context-4096'
const DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_8192 = 'deepseek-coder-v2-lite-base-context-8192'
const DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_16384 = 'deepseek-coder-v2-lite-base-context-16383'
const DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_32768 = 'deepseek-coder-v2-lite-base-context-32768'

// Model identifiers can be found in https://docs.fireworks.ai/explore/ and in our internal
// conversations
const MODEL_MAP = {
    // Virtual model strings. Cody Gateway will map to an actual model
    starcoder: 'fireworks/starcoder',
    'starcoder-16b': 'fireworks/starcoder-16b',
    'starcoder-7b': 'fireworks/starcoder-7b',

    // Fireworks model identifiers
    'llama-code-13b': 'fireworks/accounts/fireworks/models/llama-v2-13b-code',

    [FIREWORKS_DEEPSEEK_7B_LANG_SPECIFIC_V0]: 'finetuned-fim-lang-specific-model-ds2-v0',
    [FIREWORKS_DEEPSEEK_7B_LANG_SPECIFIC_V1]: 'finetuned-fim-lang-specific-model-ds2-v1',
    [FIREWORKS_DEEPSEEK_7B_LANG_ALL]: 'accounts/sourcegraph/models/finetuned-fim-lang-all-model-ds2-v0',
    [DEEPSEEK_CODER_V2_LITE_BASE]: 'fireworks/deepseek-coder-v2-lite-base',
    [DEEPSEEK_CODER_V2_LITE_BASE_DIRECT_ROUTE]:
        'accounts/sourcegraph/models/deepseek-coder-v2-lite-base',
    [DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_4096]: 'accounts/sourcegraph/models/deepseek-coder-v2-lite-base',
    [DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_8192]: 'accounts/sourcegraph/models/deepseek-coder-v2-lite-base',
    [DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_16384]:
        'accounts/sourcegraph/models/deepseek-coder-v2-lite-base',
    [DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_32768]:
        'accounts/sourcegraph/models/deepseek-coder-v2-lite-base',
}

type FireworksModel =
    | keyof typeof MODEL_MAP
    // `starcoder-hybrid` uses the 16b model for multiline requests and the 7b model for single line
    | 'starcoder-hybrid'

function getMaxContextTokens(model: FireworksModel): number {
    switch (model) {
        case 'starcoder':
        case 'starcoder-hybrid':
        case 'starcoder-16b':
        case 'starcoder-7b': {
            // StarCoder supports up to 8k tokens, we limit it to ~2k for evaluation against
            // other providers.
            return 2048
        }
        case 'llama-code-13b':
            // Llama 2 on Fireworks supports up to 4k tokens. We're constraining it here to better
            // compare the results
            return 2048
        case FIREWORKS_DEEPSEEK_7B_LANG_SPECIFIC_V0:
        case FIREWORKS_DEEPSEEK_7B_LANG_SPECIFIC_V1:
        case FIREWORKS_DEEPSEEK_7B_LANG_ALL:
        case DEEPSEEK_CODER_V2_LITE_BASE:
        case DEEPSEEK_CODER_V2_LITE_BASE_DIRECT_ROUTE: {
            return 2048
        }
        case DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_4096:
            return 4096
        case DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_8192:
            return 8192
        case DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_16384:
            return 16384
        case DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_32768:
            return 32768
        default:
            return 1200
    }
}

const lineNumberDependentCompletionParams = getLineNumberDependentCompletionParams({
    singlelineStopSequences: ['\n\n', '\n\r\n'],
    multilineStopSequences: ['\n\n', '\n\r\n'],
})

class FireworksProvider extends Provider {
    private model: FireworksModel
    private promptChars: number
    private client: CodeCompletionsClient
    private fastPathAccessToken?: string
    private authStatus: Pick<
        AuthStatus,
        'userCanUpgrade' | 'isDotCom' | 'endpoint' | 'isFireworksTracingEnabled'
    >
    private isLocalInstance: boolean
    private fireworksConfig?: ClientConfiguration['autocompleteExperimentalFireworksOptions']
    private modelHelper: DefaultModel
    private anonymousUserID: string | undefined
    private shouldEnableDirectRoute = false

    constructor(
        options: ProviderOptions,
        {
            model,
            maxContextTokens,
            client,
            config,
            authStatus,
            anonymousUserID,
        }: Required<Omit<FireworksOptions, 'anonymousUserID'>> & { anonymousUserID?: string }
    ) {
        super(options)
        this.model = model
        this.modelHelper = getModelHelpers(model)
        this.promptChars = tokensToChars(maxContextTokens - MAX_RESPONSE_TOKENS)
        this.client = client
        this.authStatus = authStatus
        this.anonymousUserID = anonymousUserID
        this.shouldEnableDirectRoute = this.checkIfDirectRouteShouldBeEnabled()
        this.isLocalInstance = Boolean(
            this.authStatus.endpoint?.includes('sourcegraph.test') ||
                this.authStatus.endpoint?.includes('localhost')
        )

        const isNode = typeof process !== 'undefined'
        this.fastPathAccessToken =
            config.accessToken &&
            // Require the upstream to be dotcom
            (this.authStatus.isDotCom || this.isLocalInstance) &&
            process.env.CODY_DISABLE_FASTPATH !== 'true' && // Used for testing
            // The fast path client only supports Node.js style response streams
            isNode
                ? dotcomTokenToGatewayToken(config.accessToken)
                : undefined

        if (
            process.env.NODE_ENV === 'development' &&
            config.autocompleteExperimentalFireworksOptions?.token
        ) {
            this.fastPathAccessToken = config.autocompleteExperimentalFireworksOptions?.token
            this.fireworksConfig = config.autocompleteExperimentalFireworksOptions
        }
    }

    private checkIfDirectRouteShouldBeEnabled(): boolean {
        const directRouteModels = [
            DEEPSEEK_CODER_V2_LITE_BASE_DIRECT_ROUTE,
            DEEPSEEK_CODER_V2_LITE_BASE_WINDOW_4096,
            FIREWORKS_DEEPSEEK_7B_LANG_ALL,
            FIREWORKS_DEEPSEEK_7B_LANG_SPECIFIC_V0,
            FIREWORKS_DEEPSEEK_7B_LANG_SPECIFIC_V1,
        ]
        return directRouteModels.includes(this.model)
    }

    public generateCompletions(
        abortSignal: AbortSignal,
        snippets: AutocompleteContextSnippet[],
        tracer?: CompletionProviderTracer
    ): AsyncGenerator<FetchCompletionResult[]> {
        const partialRequestParams = getCompletionParams({
            providerOptions: this.options,
            lineNumberDependentCompletionParams,
        })

        const { multiline } = this.options
        const useMultilineModel = multiline || this.options.triggerKind !== TriggerKind.Automatic

        const model: string =
            this.model === 'starcoder-hybrid'
                ? MODEL_MAP[useMultilineModel ? 'starcoder-16b' : 'starcoder-7b']
                : MODEL_MAP[this.model]

        const prompt = this.modelHelper.getPrompt({
            snippets,
            docContext: this.options.docContext,
            document: this.options.document,
            promptChars: this.promptChars,
        })

        const requestParams = this.modelHelper.getRequestParams({
            ...partialRequestParams,
            messages: [{ speaker: 'human', text: prompt }],
            temperature: 0.2,
            topK: 0,
            model,
        } satisfies CodeCompletionsParams)

        tracer?.params(requestParams)

        const completionsGenerators = Array.from({ length: this.options.n }).map(() => {
            const abortController = forkSignal(abortSignal)

            const completionResponseGenerator = generatorWithTimeout(
                this.createClient(requestParams, abortController),
                requestParams.timeoutMs,
                abortController
            )

            return fetchAndProcessDynamicMultilineCompletions({
                completionResponseGenerator,
                abortController,
                providerSpecificPostProcess: this.modelHelper.postProcess,
                providerOptions: this.options,
            })
        })

        /**
         * This implementation waits for all generators to yield values
         * before passing them to the consumer (request-manager). While this may appear
         * as a performance bottleneck, it's necessary for the current design.
         *
         * The consumer operates on promises, allowing only a single resolve call
         * from `requestManager.request`. Therefore, we must wait for the initial
         * batch of completions before returning them collectively, ensuring all
         * are included as suggested completions.
         *
         * To circumvent this performance issue, a method for adding completions to
         * the existing suggestion list is needed. Presently, this feature is not
         * available, and the switch to async generators maintains the same behavior
         * as with promises.
         */
        return zipGenerators(completionsGenerators)
    }

    private getCustomHeaders = (): Record<string, string> => {
        // Enabled Fireworks tracing for Sourcegraph teammates.
        // https://readme.fireworks.ai/docs/enabling-tracing
        const customHeader: Record<string, string> = {}
        if (this.authStatus.isFireworksTracingEnabled) {
            customHeader['X-Fireworks-Genie'] = 'true'
        }
        if (this.shouldEnableDirectRoute) {
            customHeader['X-Sourcegraph-Use-Direct-Route'] = 'true'
        }
        return customHeader
    }

    private createClient(
        requestParams: CodeCompletionsParams,
        abortController: AbortController
    ): CompletionResponseGenerator {
        if (this.fastPathAccessToken) {
            return createFastPathClient(requestParams, abortController, {
                isLocalInstance: this.isLocalInstance,
                fireworksConfig: this.fireworksConfig,
                logger: this.client.logger,
                providerOptions: this.options,
                fastPathAccessToken: this.fastPathAccessToken,
                customHeaders: this.getCustomHeaders(),
                authStatus: this.authStatus,
                anonymousUserID: this.anonymousUserID,
            })
        }

        return this.client.complete(requestParams, abortController, {
            customHeaders: this.getCustomHeaders(),
        })
    }
}

function getClientModel(model: string | null, isDotCom: boolean): FireworksModel {
    if (model === null || model === '') {
        return isDotCom ? DEEPSEEK_CODER_V2_LITE_BASE : 'starcoder-hybrid'
    }

    if (model === 'starcoder-hybrid' || Object.prototype.hasOwnProperty.call(MODEL_MAP, model)) {
        return model as FireworksModel
    }

    throw new Error(`Unknown model: \`${model}\``)
}

export function createProviderConfig({
    model,
    ...otherOptions
}: Omit<FireworksOptions, 'model' | 'maxContextTokens'> & {
    model: string | null
}): ProviderConfig {
    const clientModel = getClientModel(model, otherOptions.authStatus.isDotCom)
    const maxContextTokens = getMaxContextTokens(clientModel)

    return {
        create(options: ProviderOptions) {
            return new FireworksProvider(
                {
                    ...options,
                    id: PROVIDER_IDENTIFIER,
                },
                {
                    model: clientModel,
                    maxContextTokens,
                    ...otherOptions,
                }
            )
        },
        contextSizeHints: standardContextSizeHints(maxContextTokens),
        identifier: PROVIDER_IDENTIFIER,
        model: clientModel,
    }
}