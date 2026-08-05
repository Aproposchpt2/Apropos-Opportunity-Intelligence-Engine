(()=>{
  const inventoryState={timer:null,loading:false};
  const byId=id=>document.getElementById(id);
  const format=value=>Number(value||0).toLocaleString();

  function setStatus(id,label,className=''){
    const element=byId(id);
    if(!element)return;
    element.textContent=label;
    element.className=`ecc-inventory-status${className?` ${className}`:''}`;
  }

  async function loadInventory(){
    if(inventoryState.loading)return;
    inventoryState.loading=true;
    setStatus('eccCurrentContractStatus','Refreshing','ecc-loading');
    setStatus('eccPublisherStatus','Refreshing','ecc-loading');

    try{
      const data=await invoke('command-dashboard-inventory',{});
      const contracts=byId('eccCurrentContractCount');
      const publishers=byId('eccPublisherCount');
      const contractDetail=byId('eccCurrentContractDetail');
      const publisherDetail=byId('eccPublisherDetail');
      const updated=byId('eccInventoryUpdated');

      if(contracts)contracts.textContent=format(data.current_contracts);
      if(publishers)publishers.textContent=format(data.publishers);
      if(contractDetail)contractDetail.textContent=`${format(data.total_contract_records)} canonical records`;
      if(publisherDetail)publisherDetail.textContent=`${format(data.verified_publishers)} verified profiles`;
      if(updated)updated.textContent=`Updated ${new Date(data.generated_at||Date.now()).toLocaleTimeString()}`;

      setStatus('eccCurrentContractStatus','Live');
      setStatus('eccPublisherStatus','Live');
    }catch(error){
      console.error('Dashboard inventory unavailable:',error);
      const updated=byId('eccInventoryUpdated');
      if(updated)updated.textContent='Inventory unavailable';
      setStatus('eccCurrentContractStatus','Unavailable','ecc-error');
      setStatus('eccPublisherStatus','Unavailable','ecc-error');
    }finally{
      inventoryState.loading=false;
    }
  }

  window.addEventListener('apie:authenticated',()=>{
    clearInterval(inventoryState.timer);
    loadInventory();
    inventoryState.timer=setInterval(loadInventory,15000);
  });

  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='visible')loadInventory();
  });
})();
