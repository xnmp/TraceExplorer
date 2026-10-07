<script lang="ts">
  import OpenAIImageForm from "$lib/plugins/openai-image/OpenAIImageForm.svelte";
  import ContributionHarness from "./ContributionHarness.svelte";
  let open = $state(true);
  let stored: Record<string,unknown> = {};
  const storage = {get:async()=>stored,set:async(value:Record<string,unknown>)=>{stored=value;}};
  const jobs = {accept:async(_registration:unknown,start:()=>Promise<any>)=>start()};
  const toast = {show(){},error(message:string){throw new Error(message);}};
</script>
{#if open}
  <OpenAIImageForm open={true} sourcePath={null} outputDir="/fixture/images" apiKey="" {storage} {jobs} {toast} onSaveSettings={async(patch)=>{stored={...stored,...patch};}} onClose={()=>{open=false;}}/>
{/if}
<ContributionHarness/>
