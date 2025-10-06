import { initializeApp } from "https://www.gstatic.com/firebasejs/12.3.0/firebase-app.js";
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, Schema } from "https://www.gstatic.com/firebasejs/12.3.0/firebase-ai.js";

const firebaseConfig = {

};

const firebaseApp = initializeApp(firebaseConfig);
const ai = getAI(firebaseApp, { backend: new GoogleAIBackend() });

async function fileToGenerativePart(file) {
  const base64EncodedDataPromise = new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.readAsDataURL(file);
  });
  return {
    inlineData: { data: await base64EncodedDataPromise, mimeType: file.type },
  };
}

const metadataSchema = Schema.object({
  properties: {
    description: Schema.string({ description: "A concise, one-sentence description of the image." }),
    categories: Schema.array({
      description: "An array of 4-7 relevant keywords.",
      items: Schema.string(),
    }),
    dominant_colors: Schema.array({
      description: "An array of the top 3 dominant color hex codes in the image.",
      items: Schema.string(),
    }),
    has_people: Schema.boolean({ description: "A boolean value indicating if people are present." }),
  },
  required: ["description", "categories", "dominant_colors", "has_people"],
});

const sortingSchema = Schema.object({
  properties: {
    sorted_groups: Schema.array({
      description: "An array of groups, where each group contains images belonging to that category.",
      items: Schema.object({
        properties: {
          group_name: Schema.string({ description: "The name of the category or group." }),
          images: Schema.array({ items: metadataSchema }),
        },
        required: ["group_name", "images"],
      }),
    }),
  },
  required: ["sorted_groups"],
});

export async function generateImageMetadata(ai, images, userInput = '') {
  try {
    const model = getGenerativeModel(ai, {
      mode: InferenceMode.PREFER_ON_DEVICE,
      inCloudParams: { model: "gemini-2.0-flash-lite", generationConfig: { responseMimeType: "application/json", responseSchema: metadataSchema }},
      onDeviceParams: { promptOptions: { responseConstraint: metadataSchema }, createOptions: {expectedInputs: [{type: "image"}, {type: "text"}]}},
    });
    const metadataPromises = images.map(async (imageFile) => {
      const imagePart = await fileToGenerativePart(imageFile);
      let prompt = `Analyze this image and generate the following metadata in JSON format: a concise 'description', an array of 5-10 'categories', the top 3 'dominant_colors' as hex codes, and a boolean for 'has_people'.`;
      if (userInput) {
        prompt += ` Focus the analysis on the user's interest: "${userInput}".`;
      }
      const result = await model.generateContent([prompt, imagePart]);
      return JSON.parse(result.response.text());
    });
    return await Promise.all(metadataPromises);
  } catch (error) {
    console.error("Error generating image metadata:", error);
    return [];
  }
}

export async function sortAndCategorizeImages(ai, imageMetadataArray, sortBy) {
  if (!imageMetadataArray || imageMetadataArray.length === 0) return { sorted_groups: [] };
  try {
    const model = getGenerativeModel(ai, {
      mode: InferenceMode.PREFER_ON_DEVICE,
      inCloudParams: { model: "gemini-2.5-flash-lite", generationConfig: { responseMimeType: "application/json", responseSchema: sortingSchema }},
      onDeviceParams: { promptOptions: { responseConstraint: sortingSchema }},
    });

    const prompt = `You are a photo gallery organizer. Based on the following image metadata, group the images according to the user's preference to sort by **${sortBy}**. Image Metadata: ${JSON.stringify(imageMetadataArray, null, 2)}. Return a single JSON object categorizing all images into logical groups. Ensure every image is placed into exactly one group.`;
    const result = await model.generateContent(prompt);
    return JSON.parse(result.response.text());
  } catch (error) {
    console.error("Error sorting images:", error);
    return { sorted_groups: [] };
  }
}
document.addEventListener('DOMContentLoaded', () => {
    const imageUpload = document.getElementById('image-upload');
    const userInput = document.getElementById('user-input');
    const generateBtn = document.getElementById('generate-btn');
    const sortControls = document.getElementById('sort-controls');
    const statusContainer = document.getElementById('status-container');
    const resultsContainer = document.getElementById('results-container');

    let imageDataStore = [];

    imageUpload.addEventListener('change', handleImageUpload);
    generateBtn.addEventListener('click', handleMetadataGeneration);
    sortControls.addEventListener('click', handleSorting);

    function handleImageUpload(event) {
        const files = Array.from(event.target.files);
        if (files.length === 0) return;

        imageDataStore = [];
        sortControls.classList.add('hidden');
        resultsContainer.innerHTML = '';
        statusContainer.innerHTML = '';
        
        imageDataStore = files.map(file => ({
            file,
            previewUrl: URL.createObjectURL(file),
            metadata: null
        }));

        displayImagePreviews();
        generateBtn.disabled = false;
    }

    function displayImagePreviews() {
        resultsContainer.classList.remove('sorted');
        resultsContainer.innerHTML = '';
        imageDataStore.forEach((data, index) => {
            const card = document.createElement('div');
            card.className = 'image-card';
            card.id = `card-${index}`;
            card.innerHTML = `
                <img src="${data.previewUrl}" alt="User upload ${index + 1}">
                <div class="metadata-container"></div>
            `;
            resultsContainer.appendChild(card);
        });
    }

    async function handleMetadataGeneration() {
        if (imageDataStore.length === 0) return;

        generateBtn.disabled = true;
        imageUpload.disabled = true;
        userInput.disabled = true;
        statusContainer.textContent = `Analyzing ${imageDataStore.length} images...`;

        imageDataStore.forEach((_, index) => {
            const card = document.getElementById(`card-${index}`);
            if (card) {
                const metadataContainer = card.querySelector('.metadata-container');
                metadataContainer.innerHTML = '<div class="spinner"></div>';
            }
        });

        const userQuery = userInput.value.trim();
        
        const metadataPromises = imageDataStore.map(async (data, index) => {
            try {
                const [metadata] = await generateImageMetadata(ai, [data.file], userQuery);
                data.metadata = metadata;
                updateCardWithMetadata(index, metadata);
            } catch (error) {
                console.error(`Error processing image ${index}:`, error);
                updateCardWithError(index);
            }
        });
        
        await Promise.all(metadataPromises);

        statusContainer.textContent = 'Analysis complete!';
        sortControls.classList.remove('hidden');
        imageUpload.disabled = false;
        userInput.disabled = false;
    }

    async function handleSorting(event) {
        if (!event.target.classList.contains('sort-btn')) return;

        const sortBy = event.target.dataset.sortby;
        const allMetadata = imageDataStore.map(data => data.metadata).filter(Boolean);

        if (allMetadata.length === 0) {
            statusContainer.textContent = 'No metadata available to sort.';
            return;
        }

        statusContainer.textContent = `Sorting by ${sortBy}...`;
        sortControls.querySelectorAll('.sort-btn').forEach(btn => btn.disabled = true);

        try {
            const sortedResult = await sortAndCategorizeImages(ai, allMetadata, sortBy);
            displaySortedResults(sortedResult);
            statusContainer.textContent = `Images sorted by ${sortBy}`;
        } catch (error) {
            console.error('Error during sorting:', error);
            statusContainer.textContent = 'An error occurred while sorting.';
        } finally {
            sortControls.querySelectorAll('.sort-btn').forEach(btn => btn.disabled = false);
        }
    }

    function displaySortedResults(sortedData) {
        resultsContainer.innerHTML = '';
        resultsContainer.classList.add('sorted');

        if (!sortedData.sorted_groups || sortedData.sorted_groups.length === 0) {
            resultsContainer.innerHTML = `<p class="placeholder">Could not sort images into groups.</p>`;
            return;
        }

        sortedData.sorted_groups.forEach(group => {
            const groupSection = document.createElement('section');
            groupSection.className = 'result-group';
            
            const groupTitle = document.createElement('h2');
            groupTitle.textContent = group.group_name;
            groupSection.appendChild(groupTitle);

            const imageGrid = document.createElement('div');
            imageGrid.className = 'image-grid';

            group.images.forEach(metadataInGroup => {
                const originalData = imageDataStore.find(d => 
                    d.metadata && d.metadata.description === metadataInGroup.description
                );

                if (originalData) {
                    const card = createImageCard(originalData.previewUrl, originalData.metadata);
                    imageGrid.appendChild(card);
                }
            });
            groupSection.appendChild(imageGrid);
            resultsContainer.appendChild(groupSection);
        });
    }

    function updateCardWithMetadata(index, metadata) {
        const card = document.getElementById(`card-${index}`);
        if (!card) return;
        
        const metadataContainer = card.querySelector('.metadata-container');
        const colorSwatches = metadata.dominant_colors.map(color => 
            `<div class="color-swatch" style="background-color: ${color}" title="${color}"></div>`
        ).join('');

        metadataContainer.innerHTML = `
            <p class="description"><strong>Description:</strong> ${metadata.description}</p>
            <p class="categories"><strong>Categories:</strong> ${metadata.categories.join(', ')}</p>
            <div class="colors"><strong>Colors:</strong> ${colorSwatches}</div>
            <p class="people"><strong>Has People:</strong> ${metadata.has_people ? 'Yes' : 'No'}</p>
        `;
    }

    function updateCardWithError(index) {
        const card = document.getElementById(`card-${index}`);
        if (!card) return;
        const metadataContainer = card.querySelector('.metadata-container');
        metadataContainer.innerHTML = `<p class="error">Failed to analyze this image.</p>`;
    }

    function createImageCard(previewUrl, metadata) {
         const card = document.createElement('div');
         card.className = 'image-card';
         const metadataContainer = document.createElement('div');
         metadataContainer.className = 'metadata-container';

         card.innerHTML = `<img src="${previewUrl}" alt="${metadata.description}">`;
         updateMetadataContent(metadataContainer, metadata);
         card.appendChild(metadataContainer);
         return card;
    }

    function updateMetadataContent(container, metadata) {
        const colorSwatches = metadata.dominant_colors.map(color =>
            `<div class="color-swatch" style="background-color: ${color}" title="${color}"></div>`
        ).join('');
        container.innerHTML = `
            <p class="description"><strong>Description:</strong> ${metadata.description}</p>
            <p class="categories"><strong>Categories:</strong> ${metadata.categories.join(', ')}</p>
            <div class="colors"><strong>Colors:</strong> ${colorSwatches}</div>
            <p class="people"><strong>Has People:</strong> ${metadata.has_people ? 'Yes' : 'No'}</p>
        `;
    }
});