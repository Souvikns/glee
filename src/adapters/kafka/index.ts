import { Kafka, SASLOptions } from 'kafkajs'
import Adapter from '../../lib/adapter.js'
import GleeMessage from '../../lib/message.js'
import { resolveFunctions } from '../../lib/util.js'

class KafkaAdapter extends Adapter {
  private kafka: Kafka
  private firstConnect = true
  name(): string {
    return 'Kafka adapter'
  }

  async connect() {
    const kafkaOptions = await this.resolveAuthConfig()
    const securityRequirements = (this.AsyncAPIServer.security() || []).map(
      (sec) => {
        const secName = Object.keys(sec.json())[0]
        return this.parsedAsyncAPI.components().securityScheme(secName)
      }
    )
    const userAndPasswordSecurityReq = securityRequirements.find(
      (sec) => sec.type() === 'userPassword'
    )
    const scramSha256SecurityReq = securityRequirements.find(
      (sec) => sec.type() === 'scramSha256'
    )
    const scramSha512SecurityReq = securityRequirements.find(
      (sec) => sec.type() === 'scramSha512'
    )

    const brokerUrl = new URL(this.AsyncAPIServer.url())
    this.kafka = new Kafka({
      clientId: 'glee-app',
      brokers: [brokerUrl.host],
      ssl: {
        rejectUnauthorized: kafkaOptions?.rejectUnauthorized,
        key: kafkaOptions?.key,
        cert: kafkaOptions?.cert,
      },
      sasl: {
        mechanism: (scramSha256SecurityReq ? 'scram-sha-256' : undefined) || (scramSha512SecurityReq ? 'scram-sha-512' : undefined) || 'plain',
        username: userAndPasswordSecurityReq ? kafkaOptions?.username : undefined,
        password: userAndPasswordSecurityReq ? kafkaOptions?.password : undefined,
      } as SASLOptions,
    })

    const consumer = this.kafka.consumer({ groupId: 'glee-group' })
    consumer.on('consumer.connect', () => {
      if (this.firstConnect) {
        this.firstConnect = false
        this.emit('connect', {
          name: this.name(),
          adapter: this,
          connection: consumer,
          channels: this.getSubscribedChannels()
        })
      }
    })
    await consumer.connect()
    const subscribedChannels = this.getSubscribedChannels()
    await consumer.subscribe({ topics: subscribedChannels, fromBeginning: true })
    await consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        const msg = this._createMessage(topic, partition, message)
        this.emit('message', msg, consumer)
      },
    })
  }

  async send(message: GleeMessage) {
    const producer = this.kafka.producer()
    await producer.connect()
    await producer.send({
      topic: message.channel,
      messages: [{
        key: message.headers.key,
        value: message.payload,
        timestamp: message.headers.timestamp,
      }],
    })
    await producer.disconnect()
  }

  _createMessage(topic, partition, message) {
    return new GleeMessage({
      channel: topic,
      payload: message.value,
      headers: {
        partition,
        key: message.key,
        offset: message.offset,
        timestamp: message.timestamp,
        ...message.headers,
      },
    })
  }

  private async resolveAuthConfig() {
    const config = this.glee.options?.kafka
    if (!config) return 
    const auth = config?.auth
    if (!auth) return 

    if (typeof auth !== 'function') {
      await resolveFunctions(auth)
      return auth
    }

    return await auth({ serverName: this.serverName, parsedAsyncAPI: this.parsedAsyncAPI })
  }
}

export default KafkaAdapter
