export class TextGenetorLLM {
  model;
  temperature;
  messages;
  constructor(model, temperature, messages){
    this.model = model;
    this.temperature = temperature;
    this.messages = messages;
  }
  modelConfiguration() {
    return {
      model: this.model,
      temperature: this.temperature,
      messages: [
        {
          role: 'user',
          content: this.messages
        }
      ]
    };
  }
}
