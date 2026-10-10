/** SDK 3 declared image-generation v1. Public requests never contain credentials or provider paths. */
export interface ArtifactDescriptor {handle:string;sha256:string;byteLength:number;mediaType:string}
export interface ImageOptions {size:string;resolution?:string|null;aspectRatio?:string|null;quality:"auto"|"low"|"medium"|"high";background:"auto"|"opaque"|"transparent"}
export interface ImagePrepareRequest {operationId:string;connectionId:string;expectedConnectionRevision:string;model:string|null;prompt:string;inputs:readonly ArtifactDescriptor[];options:ImageOptions}
export interface EffectiveRecipe {schemaVersion:1;formatterVersion:1;connectionId:string;connectionRevision:string;adapter:string;endpointIdentity:string;model:string|null;options:ImageOptions;inputDigests:readonly string[];inputRoles:readonly string[];submittedPrompt:string;agentTask:string|null}
export interface ImagePreparation {preparationToken:string;effectiveRecipe:EffectiveRecipe;effectiveRecipeDigest:string}
export interface ImageStartRequest extends ImagePrepareRequest {preparationToken:string;effectiveRecipeDigest:string}
export interface ServiceError {code:string;message:string;correlationId?:string|null}
export interface ImageMetadata {adapter:string;endpointIdentity:string;requestedModel:string|null;actualModel:string|null;externalRequestId:string|null;threadId:string|null;options:ImageOptions;remoteChargeUncertain:boolean}
export type ImageExecution =
  | {state:"accepted"|"running"|"cancelled"}
  | {state:"succeeded";metadata:ImageMetadata}
  | {state:"failed"|"unknown";error:ServiceError};
export type ImageDelivery =
  | {state:"none"|"discarded"}
  | {state:"available";output:ArtifactDescriptor}
  | {state:"acquired";transferReceipt:string}
  | {state:"unavailable";reason:"missing"|"corrupt"|"storage_unavailable"};
export interface CodexTurnReceipt {kind:"codex_image_turn";threadId:string;turnState:"completed"|"failed"|"incomplete";usage?:{inputTokens?:number|null;cachedInputTokens?:number|null;outputTokens?:number|null}|null;explanation?:{kind:"reply"|"error";text:string;truncated:boolean}|null}
export interface ImageOperationStatus {version:1;operationId:string;requestFingerprint:string;provider:{packageId:string;serviceId:string;major:1};revision:number;execution:ImageExecution;delivery:ImageDelivery;diagnostics?:CodexTurnReceipt}
export interface ImageCapabilities {generation:boolean;edit:boolean;maxInputs:number;maxInputBytes:number;maxTotalInputBytes:number;maxOutputBytes:number;inputFormats:readonly string[];outputFormats:readonly string[];modelSelection:boolean;sizes:{auto:boolean;maxEdge:number;multipleOf:number;minPixels:number;maxPixels:number};quality:readonly string[];background:readonly string[]}
export type ImageCredential = {kind:"none"}|{kind:"environment";name:string}|{kind:"secret";id:string};
export type ImageProfile =
  | {id:string;name:string;recipeRevision:string;transport:"codex-cli";executablePath:string;modelSelection:false;credential:{kind:"cli_saved_login"}}
  | {id:string;name:string;recipeRevision:string;transport:"openai-images";baseUrl:string;defaultModel:string;allowInsecureHttp:boolean;credential:ImageCredential;hasCredential?:boolean};
export interface ImageConfiguration {schemaVersion:1;documentRevision:number;defaultConnectionId:string|null;profiles:readonly ImageProfile[]}
export interface ImageDescription {version:1;configurationRevision:number;defaultConnectionId:string|null;profiles:readonly (ImageProfile&{capabilities:ImageCapabilities})[]}
