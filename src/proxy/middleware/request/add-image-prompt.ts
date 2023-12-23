import { ProxyRequestMiddleware } from ".";



interface TextBlock {
  type: 'text';
  text: string;
}

interface ImageBlock {
  type: 'image_url';
  image_url: string;
}

type ContentBlock = TextBlock | ImageBlock;


function extractImageUrls(text?: string): string[] {
  if (typeof text !== 'string') {
    return [];
  }
  const regexPattern = /(http|ftp|https):\/\/([\w_-]+(?:(?:\.[\w_-]+)+))([\w.,@?^=%&:\/~+#-]*[\w@?^=%&\/~+#-])/g;
  const matched = text.match(regexPattern);
  const imageUrls: string[] = [];
  if (matched) {
    matched.forEach((url) => {
      if (/\.(jpg|png|gif|webp)$/.test(url)) {
        imageUrls.push(url);
      }
    });
  }
  return imageUrls;
}

function getMimeTypeOfUri(url: string): string {
	if (typeof url !== 'string') {
		return ''
	};
	const parts = url.split(".");
	const format = parts[parts.length - 1];
	let mimeType = ""
	if (format === "png" || format === "jpeg") {
	  mimeType = "image/" + format;
	} else if (
	  format === "mov" ||
	  format === "mpeg" ||
	  format === "mp4" ||
	  format === "mpg" ||
	  format === "avi" ||
	  format === "wmv" ||
	  format === "mpegps" ||
	  format === "flv"
	) {
	  mimeType = "video/" + format;
	}
	return mimeType
}


function extractGeminiUrls(text?: string): string[] {
  if (typeof text !== 'string') {
    return [];
  }
  const regexPattern = /(http|ftp|https):\/\/([\w_-]+(?:(?:\.[\w_-]+)+))([\w.,@?^=%&:\/~+#-]*[\w@?^=%&\/~+#-])/g;
  const matched = text.match(regexPattern);
  const imageUrls: string[] = [];
  if (matched) {
    matched.forEach((url) => {
	  if (/\.(jpeg|jpg|png|mov|mp4|mpg|avi|wmv|mpeg|mpegps|flv)$/.test(url)) {
        imageUrls.push(url);
      }
    });
  }
  return imageUrls;
}


function urlToBase64(url: string): Promise<string> {
  return fetch(url)
    .then(response => response.blob())
    .then(blob => {
      return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => {
          const base64String = reader.result as string;
          const base64 = base64String.split(",")[1];
          resolve(base64);
        };
        reader.onerror = (error) => {
          reject(error);
        };
        reader.readAsDataURL(blob);
      });
    });
}


/** Finalize the rewritten request body. Must be the last rewriter. */
export const addImageFromPrompt: ProxyRequestMiddleware = (_proxyReq, req) => {
  if (["POST", "PUT", "PATCH"].includes(req.method ?? "") && req.body) {

    if (req.body?.model !== "gpt-4-vision-preview") {
      return;
    }
    // Remove potentially problematic fields
    delete req.body['stop'];
    delete req.body['logit_bias'];

    // Iterate over the array of messages
    for (let i = 0; i < req.body.messages.length; i++) {
      if (typeof req.body.messages[i].content === 'string') {
        // We are assuming extractImageUrls is a function that exists in the scope and is imported or written above this function
        let image_links = extractImageUrls(req.body.messages[i].content);

        // Replace string content with an array including the original text and any extracted image urls
        let newContent: ContentBlock[] = [{ type: 'text', text: req.body.messages[i].content }];

		for (let x = 0; x < image_links.length; x++) {
		  newContent.push({
			type: 'image_url',
			image_url: image_links[x],
		  } as ImageBlock); // Casting it as ImageBlock to satisfy TypeScript
		};

        // Update the content of the message with the new array containing text and image URLs
        req.body.messages[i].content = newContent as ContentBlock[];
      }
    }
  }
};



interface geminiText {
  "text": string
}

interface geminiContentBlock {
  "parts": [
	  { 
		  "inlineData": {
			"mimeType": string;
			"data": string;
		  } 
	  },
	  { "text": string } 
  ]
}



export const addImageFromPromptGemini: ProxyRequestMiddleware = (_proxyReq, req) => {
  if (["POST", "PUT", "PATCH"].includes(req.method ?? "") && req.body) {

    if (req.body?.model !== "gemini-pro-vision") {
      return;
    }
	let newContent: geminiContentBlock[] = []

    // Iterate over the array of messages
    for (let i = 0; i < req.body.contents.length; i++) {
	  for (let partN =0; partN < req.body.contents[i].parts.length; partN++) {
	  
		  if (typeof req.body.contents[i].parts[partN].text === 'string') {

			// We are assuming extractImageUrls is a function that exists in the scope and is imported or written above this function
			const image_links = extractGeminiUrls(req.body.contents[i].parts[partN].text);
			for (let x = 0; x < image_links.length; x++) {
				let imageData = ""
				
			
			    newContent = [{ "parts": [
					{
						"inlineData": {mimeType: getMimeTypeOfUri(image_links[x]), "data": imageData }
					},
					{ "text": req.body.contents[i].parts[partN].text}
					
				]
			  }]
			  
			  const newText: geminiText = {text: req.body.contents[i].parts[partN].text};


			  req.body.contents[i].parts[partN] = newContent[0], newText
			}

			
		  }
	  }
    }
	
	
	if (newContent) {
		for (let i = 0; i < req.body.contents.length; i++) {
			if (i >= 1) {
				delete req.body.contents[i] // Gemini vision doesnt' support multi turn chat
			} else {
				req.body.contents[i] = newContent
			}
		}
	}
	
	
  }
};