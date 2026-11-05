// The browser's UI never needs to run the compression or JSON decoding loops.
importScripts("./vendor/fflate-0.8.2.js?v=20261105","./cloud-storage.js?v=20261106-storage2");
self.onmessage = async ({data:{id,method,args}}) => {
  try {
    let result;
    if (method === "pack") result = await PFMCloudStorage.pack(args.data,args.inlineLimit);
    else if (method === "unpack") result = await PFMCloudStorage.unpack(args.data);
    else throw new Error("Unknown storage operation");
    self.postMessage({id,result});
  } catch (error) {self.postMessage({id,error:{message:error.message,code:error.code || "unknown"}});}
};
