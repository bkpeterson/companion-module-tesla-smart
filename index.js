// @ts-check

import { InstanceBase, InstanceStatus, Regex, TCPHelper, combineRgb, runEntrypoint } from '@companion-module/base'
import { UpgradeScripts } from './upgrades.js'

/**
 * @param {number} count
 * @returns {import('@companion-module/base').DropdownChoice[]}
 */
function generateChoices(count) {
	const choices = []

	for (let i = 1; i <= count; i++) {
		choices.push({
			id: `${i}`,
			label: `Source ${i}`,
		})
	}

	return choices
}

class instance extends InstanceBase {
	async init(config) {
		this.config = config

		this.current_host_id = 0

		// Connect to KVM device
		this.init_tcp()

		// Start polling for feedback
		this.#start_polling_for_host()

		// Initialize the feedback workflow
		this.initActions()
		this.initFeedbacks()
		this.initVariables()
		this.setVariableValues({
			currentPort: 0,
		})
	}

	// Reconnect to KVM after config updated, in case of IP or port change
	async configUpdated(config) {
		this.config = config

		if (this.socket) {
			this.socket.destroy()
			delete this.socket
		}

		this.initActions()
		this.initFeedbacks()
		this.initVariables()

		this.init_tcp()

		this.#stop_polling_for_host()
		this.#start_polling_for_host()
	}

	init_tcp() {
		if (this.socket) {
			this.socket.destroy()
			delete this.socket
		}

		this.updateStatus(InstanceStatus.Connecting)

		this.receivedBuffer = []

		if (this.config.host) {
			this.socket = new TCPHelper(this.config.host, this.config.port)

			this.socket.on('status_change', (status, message) => {
				this.updateStatus(status, message)
			})

			this.socket.on('error', (err) => {
				this.updateStatus(InstanceStatus.UnknownError, err.message)
				this.log('error', 'Network error: ' + err.message)
			})

			this.socket.on('connect', () => {
				this.updateStatus(InstanceStatus.Ok)
			})

			this.socket.on('data', (chunk) => {
				const data = Buffer.from(chunk)
				this.receivedBuffer.push(data)
				if(this.receivedBuffer.length >= 6) {
					this.log('debug', 'Received ' + this.receivedBuffer.toString('hex'))

					this.#processData(this.receivedBuffer)
					this.receivedBuffer = []
				}
			})
		}
	}

	/**
	 * @returns {import('@companion-module/base').SomeCompanionConfigField[]}
	 */
	getConfigFields() {
		return [
			{
				type: 'textinput',
				id: 'host',
				label: 'KVM IP',
				width: 6,
				regex: Regex.IP,
			},
			{
				type: 'number',
				id: 'port',
				label: 'Target Port',
				width: 6,
				default: 5000,
				min: 1,
				max: 65535,
			},
			{
				type: 'number',
				id: 'sources',
				label: '# of sources',
				width: 6,
				min: 1,
				max: 16,
				default: 8,
			},
			{
				type: 'number',
				id: 'poll',
				label: 'Feedback poll interval (ms) - 0 to disable, max 60000',
				width: 6,
				min: 0,
				max: 60000,
				default: 5000,
			},
		]
	}

	// When module gets deleted
	async destroy() {
		this.#stop_polling_for_host()

		if (this.socket) {
			this.socket.destroy()
		}
	}

	initActions() {
		const inputChoices = generateChoices(this.config.sources)

		this.setActionDefinitions({
			switch: {
				name: 'Switch source',
				options: [
					{
						type: 'dropdown',
						id: 'id_send',
						label: 'Source:',
						default: '1',
						choices: inputChoices,
					},
				],
				callback: async (action) => {
					const cmd = Buffer.from([0xaa, 0xbb, 0x03, 0x01, 0x00, 0xee])
					cmd.writeUint8(Number(action.options.id_send), 4)

					await this.#sendCommand(cmd)
				},
			},
		})
	}

	/**
	 * @param {Buffer} cmd
	 */
	async #sendCommand(cmd) {
		this.log('debug', 'sending ' + cmd.toString('hex') + ' to ' + this.config.host)

		if (this.socket && this.socket.isConnected) {
			this.socket.send(cmd)
		} else {
			this.log('debug', 'Socket not connected :(')
		}
	}

	initVariables() {
		this.setVariableDefinitions([
			{
				name: 'Current active HDMI port',
				variableId: 'currentPort',
			},
		])
	}

	initFeedbacks() {
		const inputChoices = generateChoices(this.config.sources)

		this.setFeedbackDefinitions({
			current_host: {
				type: 'boolean',
				name: 'Currently selected source',
				description: 'Feedback showing the currently selected source',
				defaultStyle: {
					bgcolor: combineRgb(0, 255, 0),
					color: combineRgb(0, 0, 0),
				},
				options: [
					{
						type: 'dropdown',
						label: 'Source',
						id: 'host_id',
						default: '1',
						choices: inputChoices,
					},
				],
				callback: (feedback) => {
					return Number(feedback.options.host_id) === this.current_host_id
				},
			},
		})
	}

	#poll_for_active_host() {
		this.log('debug', 'Polling KVM ' + this.config.host)

		this.#sendCommand(Buffer.from([0xaa, 0xbb, 0x03, 0x10, 0x00, 0xee]))
	}

	#start_polling_for_host() {
		if (this.config.poll > 0) {
			this.host_poller = setInterval(this.#poll_for_active_host.bind(this), this.config.poll)

			this.#poll_for_active_host()
		}
	}

	#stop_polling_for_host() {
		if (this.host_poller) {
			clearInterval(this.host_poller)
			delete this.host_poller
		}
	}

	/**
	 * @param {Buffer} data
	 */
	#processData(data) {
		if (data.length === 6 && data[0] == 0xaa && data[1] == 0xbb && data[2] == 0x03 && data[3] == 0x11) {
			this.current_host_id = data[4] + 1

			this.setVariableValues({
				currentPort: this.current_host_id,
			})
			this.checkFeedbacks('current_host')
		}
	}
}

runEntrypoint(instance, UpgradeScripts)
