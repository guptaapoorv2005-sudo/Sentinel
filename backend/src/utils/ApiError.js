class ApiError extends Error{
    constructor(statusCode, message = "Something went wrong", errors = [], stack = ""){
        super(message)     //jab class extend karte hain toh super constructor call karna padhta hai ek baar varna this use nhi kar sakte
        this.statusCode = statusCode
        this.data = null
        this.success = false
        this.errors = errors

        if(stack){
            this.stack = stack
        }
        else{
            Error.captureStackTrace(this, this.constructor)
        }
    }
}

export {ApiError}